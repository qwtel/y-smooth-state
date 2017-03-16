/*
 * Adapted from Miguel Ángel Pérez's smoothState.js
 * https://github.com/miguel-perez/smoothState.js
 *
 * Copyright (c) 2016 Florian Klampfer
 * Licensed under MIT
 */
/* eslint-disable import/no-extraneous-dependencies, import/no-unresolved, import/extensions */

// const JS_FEATURES = [
//   'fn/array/for-each',
//   'fn/function/bind',
//   'fn/number/constructor',
//   'fn/object/assign',
//   'fn/object/define-property',
//   'fn/object/keys',
// ];
//
// const MODERNIZR_TESTS = [
//   'customevent',
//   'documentfragment',
//   'eventlistener',
//   'history',
//   'requestanimationframe',
//   'queryselector',
// ];

import { Observable } from 'rxjs/Observable';
import { Subject } from 'rxjs/Subject';
import { asap } from 'rxjs/scheduler/asap';

import 'rxjs/add/observable/defer';
import 'rxjs/add/observable/empty';
import 'rxjs/add/observable/fromEvent';
import 'rxjs/add/observable/merge';
import 'rxjs/add/observable/of';
import 'rxjs/add/observable/throw';
import 'rxjs/add/observable/timer';

import 'rxjs/add/observable/dom/ajax';

import 'rxjs/add/operator/catch';
import 'rxjs/add/operator/delay';
import 'rxjs/add/operator/distinctUntilKeyChanged';
import 'rxjs/add/operator/do';
import 'rxjs/add/operator/filter';
import 'rxjs/add/operator/map';
import 'rxjs/add/operator/merge';
import 'rxjs/add/operator/mergeAll';
import 'rxjs/add/operator/observeOn';
import 'rxjs/add/operator/share';
import 'rxjs/add/operator/startWith';
import 'rxjs/add/operator/switch';
import 'rxjs/add/operator/switchMap';
import 'rxjs/add/operator/take';
import 'rxjs/add/operator/takeUntil';
import 'rxjs/add/operator/withLatestFrom';
import 'rxjs/add/operator/zip';

import componentCore from 'y-component/src/component-core';

import { shouldLoadAnchor, getScrollTop, getScrollHeight } from '../common';
import { Push, Hint, Pop } from './kind';

const def = Object.defineProperty.bind(Object);

function fragmentFromString(strHTML) {
  return document.createRange().createContextualFragment(strHTML);
}

// ~ mixin pushStateCore with componentCore { ...
export default C => class extends componentCore(C) {

  // @override
  getComponentName() {
    return 'y-push-state';
  }

  // @override
  defaults() {
    return {
      replaceIds: [],
      linkSelector: 'a[href]',
      scrollRestoration: false,
      hrefRegex: null,
      blacklist: null,
      duration: 0,
    };
  }

  // @override
  sideEffects() {
    return {};
  }

  startHistory() {
    this.checkPreCondition();
    this.setupScrollRestoration();
    // this.resetScrollPostion();
    this.cacheTitleElement();
    this.setupObservables();
    return this;
  }

  checkPreCondition() {
    if (this.replaceIds.length === 0) {
      const id = this.el.id;
      if (id) {
        console.warn(`No replace ids provided. Will replace entire content of #${id}`); // eslint-disable-line no-console
      } else {
        throw Error('No replace ids provided nor does this component have and id'); // eslint-disable-line no-console
      }
    }
  }

  setupScrollRestoration() {
    if ('scrollRestoration' in history) {
      history.scrollRestoration = this.scrollRestoration ? 'manual' : 'auto';
    }

    if (this.scrollRestoration) {
      this.resetScrollPostion();
      window.addEventListener('beforeunload', () => {
        this.updateHistoryState();
      });
    }
  }

  cacheTitleElement() {
    def(this, 'titleElement', { value: document.querySelector('title') || {} });
  }

  bindPushEvents(link$) {
    return this.fromEvents(link$, 'click')
      .map(event => new Push(event))
      .filter(kind => this.isPageChangeEvent(kind))
      .do(({ event }) => {
        this.updateHistoryState();
        event.preventDefault();
      });
  }

  bindHintEvents(link$) {
    return Observable.merge(
        this.fromEvents(link$, 'mouseenter'),
        this.fromEvents(link$, 'touchstart'),
        this.fromEvents(link$, 'focus'),
      )
      .map(event => new Hint(event))
      .filter(kind => this.isPageChangeAnchor(kind));
  }

  bindPopstateEvent() {
    return Observable.fromEvent(window, 'popstate')
      .map(event => new Pop(event))
      .filter(() => window.history.state != null);
  }

  linkObservable() {
    return Observable.of(this.el.querySelectorAll(this.linkSelector));
  }

  fromEvents(link$, event) {
    return link$.map(link => Observable.fromEvent(link, event)).mergeAll();
  }

  fetchPage(kind) {
    const requestData = this.hrefToRequestData(kind);
    return Observable
      .ajax(requestData)
      .map(({ response }) => Object.assign(kind, { response }))
      .catch(error => this.recoverWhenResponse(kind, error));
  }

  hrefToRequestData({ href }) {
    return {
      method: 'GET',
      url: href,
      responseType: 'text',
    };
  }

  recoverWhenResponse(kind, error) {
    const { status, xhr } = error;

    if (status && status > 400 && xhr) {
      // Recover with error page returned from server.
      // Assumes error page contains the same ids as other pages.
      return Observable.of(Object.assign(kind, { response: xhr.response }));
    }

    // TODO: Don't throw here?
    return Observable.throw(error);
  }

  setupObservables() {
    // See `renewEventListeners`
    // TODO: Possible without subjects?
    this.push$$ = new Subject();
    this.hint$$ = new Subject();

    const push$ = this.push$$.switch();
    const pop$ = this.bindPopstateEvent();

    // Definitive page change (i.e. either push or pop event)
    this.page$ = Observable.merge(push$, pop$);

    // We don't want to prefetch (i.e. use bandwidth) for a _probabilistic_ page load,
    // while a _definitive_ page load is going on => `pauser$` stream.
    // Needs to be deferred b/c of "cyclical" dependency.
    const pauser$ = Observable.defer(() =>
      Observable.merge(
        // A page change event means we want to pause prefetching
        this.page$.map(() => true),
        // A render complete event means we want to resume prefetching
        this.render$.map(() => false),
      )
        // Start with prefetching
        .startWith(false),
    );

    // The stream of hint (prefetch) events, possibly paused.
    // Dream syntax (not supported, yet): `this.hint$$.switch().pauseable(pauser$)`
    this.hint$ = this.hint$$.switch()
      .withLatestFrom(pauser$)
      .filter(([, paused]) => paused === false)
      .map(([x]) => x);

    // The stream of (pre-)fetch events.
    // Includes definitive page change events do deal with unexpected page changes.
    const prefetch$ = Observable.merge(this.hint$, this.page$)
      .distinctUntilKeyChanged('href') // Don't abort a request if the user "jiggles" over a link
      .switchMap(kind => this.fetchPage(kind))
      .startWith({}) // Start with some value so `withLatestFrom` below doesn't "block"
      .share();

    this.render$ = this.page$
      .do(this.onStart.bind(this))
      .withLatestFrom(prefetch$)
      .switchMap(([kind, prefetch]) => {
        const timer$ = Observable.timer(this.duration).share();

        const response$ = kind.href === prefetch.href ?
            // Prefetch already complete, use result
            Observable.of(Object.assign(kind, { response: prefetch.response })) :
              // .delay(this.duration) :
            // Prefetch in progress, use next result (this is why `prefetch$` had to be `share`d)
            prefetch$.take(1)
              .map(fetch => Object.assign(kind, { response: fetch.response }))
              .zip(timer$, x => x)
          .share();

        timer$.takeUntil(response$).subscribe(() => this.onProgress(kind));

        return response$;
      })
      .map(this.responseToHTML.bind(this))
      .do(this.onReady.bind(this))
      .do(this.updateDOM.bind(this))
      // Push renewing event listeners out after layout/painting is complete
      .observeOn(asap)
      .do(this.onAfter.bind(this))
      .do(this.renewEventListeners.bind(this))
      // `share`ing the stream between the subscription below and `pauser$`.
      .share();

    // Start pulling values
    this.render$.subscribe(() => {});

    // Push streams into `push$$` and `hint$$`
    this.renewEventListeners();
  }

  renewEventListeners() {
    const link$ = this.linkObservable();
    this.push$$.next(this.bindPushEvents(link$));
    this.hint$$.next(this.bindHintEvents(link$));
  }

  responseToHTML(sponge) {
    const { response } = sponge;

    const documentFragment = fragmentFromString(response);
    const title = this.getTitleFromDocumentFragment(documentFragment);
    const content = this.getContentFromDocumentFragment(documentFragment);

    return Object.assign(sponge, { title, content });
  }

  updateDOM(sponge) {
    const { href, title, content } = sponge;

    if (sponge instanceof Push) {
      window.history.pushState({ id: this.componentName }, title, href);
    }

    this.titleElement.textContent = title;
    this.resetScrollPostion();
    this.replaceContent(content);
  }

  onStart(sponge) {
    this.fireEvent('start', { detail: sponge });
  }

  onProgress(sponge) {
    this.fireEvent('progress', { detail: sponge });
  }

  onReady(sponge) {
    this.setWillChange();
    this.fireEvent('ready', { detail: sponge });
  }

  onAfter(sponge) {
    this.unsetWillChange();
    this.fireEvent('after', { detail: sponge });
  }

  // onError() {
  //   this.el.style.willChange = '';
  //   document.body.style.willChange = '';
  //   this.fireEvent('error');
  // }

  setWillChange() {
    // this.el.style.willChange = 'content';
    // document.body.style.willChange = 'scroll-position';
  }

  unsetWillChange() {
    // this.el.style.willChange = '';
    // document.body.style.willChange = '';
  }

  isPageChangeEvent(kind) {
    const { event } = kind;
    return (
      !event.metaKey &&
      !event.ctrlKey &&
      this.isPageChangeAnchor(kind)
    );
  }

  isPageChangeAnchor({ event: { currentTarget: anchor } }) {
    return (
      anchor != null &&
      shouldLoadAnchor(anchor, this.blacklist, this.hrefRegex)
    );
  }

  getTitleFromDocumentFragment(documentFragment) {
    return (documentFragment.querySelector('title') || {}).textContent;
  }

  getContentFromDocumentFragment(documentFragment) {
    if (this.replaceIds.length > 0) {
      return this.replaceIds.map(id => documentFragment.querySelector(`#${id}`));
    }

    return documentFragment.getElementById(this.el.id);
  }

  replaceContent(content) {
    if (this.replaceIds.length > 0) {
      this.replaceContentByIds(content);
    } else {
      this.replaceContentWholesale(content);
    }
  }

  // TODO: Rename
  checkCondition(oldElements, content) {
    // TODO: Just replace existing ids, remove missing ides
    // TODO: Remove in production builds
    if (content.length !== oldElements.length) {
      throw Error("New document doesn't contain the same number of ids");
    }
  }

  replaceContentByIds(content) {
    const oldElements = this.replaceIds
      .map(id => document.getElementById(id));

    this.checkCondition(oldElements, content);

    Array.prototype.forEach.call(oldElements, (oldElement) => {
      oldElement.parentNode.replaceChild(content.shift(), oldElement);
    });
  }

  replaceContentWholesale(content) {
    this.el.innerHTML = content.innerHTML;
  }

  saveScrollPosition(state) {
    if (this.scrollRestoration) {
      return Object.assign(state, {
        scrollTop: getScrollTop(),
        scrollHeight: getScrollHeight(),
      });
    }
    return state;
  }

  updateHistoryState() {
    const state = history.state || { id: this.componentName };
    const stateWithScrollPosition = this.saveScrollPosition(state);
    history.replaceState(stateWithScrollPosition, document.title, window.location.href);
  }

  resetScrollPostion() {
    if (this.scrollRestoration) {
      const state = history.state || {};
      document.body.style.minHeight = `${state.scrollHeight || 0}px`;
      window.scrollTo(window.pageXOffset, state.scrollTop || 0);
    }
  }
};
