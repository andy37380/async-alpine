import * as strategies from './strategies/index.js';
import parseRequirements from './requirement-parser.js';

const internalNamePrefix = '__internal_';

const AsyncAlpine = {
  Alpine: null,

  // custom options, over-ridden by the second param of init
  _options: {
    prefix: 'ax-',
    alpinePrefix: 'x-',
    root: 'load',
    inline: 'load-src',
    stores: 'stores',
    defaultStrategy: 'eager',
    alias: false,
  },

  // if we fall back to an alias when components aren't pre-registered
  _alias: false,

  // data cache
  _data: {},

  // index for ID generation
  _realIndex: 0,
  get _index() {
    return this._realIndex++;
  },

  /**
   * =================================
   * lifecycle
   * =================================
   */
  // initialise Alpine and options
  init(Alpine, opts = {}) {
    this.Alpine = Alpine;
    this._options = {
      ...this._options,
      ...opts,
    };
    return this;
  },

  // actually run stuff
  start() {
    this.alias(this._options.alias);
    this._processInline();
    this._setupComponents();
    this._mutations();
    return this;
  },

  /**
   * =================================
   * component registration
   * =================================
   */
  // register a component internally
  data(name, download = false) {
    this._data[name] = {
      loaded: false,
      download,
    };
    return this;
  },

  // shorthand to register a component with a URL in JS
  url(name, url) {
    if (!name || !url) return;
    if (!this._data[name]) this.data(name);
    this._data[name].download = () => import(
      /* @vite-ignore */
      /* webpackIgnore: true */
      this._parseUrl(url)
    );
  },

  // fall back to requesting an unknown URL if a component isn't registered
  alias(path) {
    this._alias = path;
  },

  /**
   * =================================
   * process inline components
   * =================================
   */
  // loop through all elements with ax-load-src to process them
  _processInline() {
    const inlineComponents = document.querySelectorAll(`[${this._options.prefix}${this._options.inline}]`);
    for (const component of inlineComponents) {
      this._inlineElement(component);
    }
  },

  // process element to add the download function for this component
  _inlineElement(component) {
    const xData = component.getAttribute(`${this._options.alpinePrefix}data`);
    let srcUrl = component.getAttribute(`${this._options.prefix}${this._options.inline}`);
    if (!xData || !srcUrl) return;

    const name = this._parseName(xData);
    this.url(name, srcUrl);
  },

  _findOutermostElementsWithAttribute(node, attributeName, output) {
    if (!output) {
      output = [];
    }

    let isFound = false;
    if (node.nodeType === Node.ELEMENT_NODE) {
      if (node.hasAttribute(attributeName)) {
        output.push(node);
        isFound = true;
      }
    }

    if (!isFound) {
      for (let i = 0; i < node.childNodes.length; i++) {
        this._findOutermostElementsWithAttribute(node.childNodes[i], attributeName, output);
      }
    }
    return output;
  },

  /**
   * =================================
   * set up components
   * =================================
   */
  // loop through elements with ax-load and set them up as components
  _setupComponents() {
    const elements = this._findOutermostElementsWithAttribute(document, `${this._options.prefix}${this._options.root}`);

    for (let element of elements) {
      this._setupComponent(element);
    }
  },

  // set this element up as a component
  _setupComponent(component) {
    const xData = component.getAttribute(`${this._options.alpinePrefix}data`);
    component.setAttribute(`${this._options.alpinePrefix}ignore`, '');

    const name = this._parseName(xData);
    const strategy = component.getAttribute(`${this._options.prefix}${this._options.root}`) || this._options.defaultStrategy;
    const storeNamesJoinWithComma = component.getAttribute(`${this._options.prefix}${this._options.stores}`) || '';
    const storeNames = storeNamesJoinWithComma.split(',').filter(el => el);

    this._componentStrategy({
      name,
      strategy,
      el: component,
      id: component.id || this._index,
      storeNames: storeNames,
    });
  },

  /**
   * =================================
   * component strategies
   * =================================
   * split strategy into unique requirements and download the
   * component when requirements have been met
   */
  async _componentStrategy(outermostComponent) {
    const nodeList = outermostComponent.el.querySelectorAll(`[${this._options.prefix}${this._options.root}]`);
    const elements = [outermostComponent.el].concat(Array.from(nodeList));

    for (let element of elements) {
      const xData = element.getAttribute(`${this._options.alpinePrefix}data`);
      element.setAttribute(`${this._options.alpinePrefix}ignore`, '');
  
      const name = this._parseName(xData);
      const strategy = element.getAttribute(`${this._options.prefix}${this._options.root}`) || this._options.defaultStrategy;
      const storeNamesJoinWithComma = element.getAttribute(`${this._options.prefix}${this._options.stores}`) || '';
      const storeNames = storeNamesJoinWithComma.split(',').filter(el => el);

      const component = {
        name,
        strategy,
        el: element,
        id: element.id || this._index,
        storeNames: storeNames,
      };

      const requirements = parseRequirements(strategy);
      await this._downloadStores(storeNames);
      await this._generateRequirements(component, requirements);
      await this._download(name);
    }

    for (let element of elements) {
      this._activate(element);
    }
  },

  _generateRequirements(component, obj) {
    if (obj.type === 'expression') {
      if (obj.operator === '&&') {
        return Promise.all(
          obj.parameters
            .map(param => this._generateRequirements(component, param))
        );
      }

      if (obj.operator === '||') {
        return Promise.any(
          obj.parameters
            .map(param => this._generateRequirements(component, param))
        );
      }
    }

    if (!strategies[obj.method]) return false;

    return strategies[obj.method]({
      component,
      argument: obj.argument,
    });
  },

  /**
   * =================================
   * component download
   * =================================
   */
  // check if the component has been downloaded, if not trigger download and register with Alpine
  async _download(name, isStore) {
    if (name.startsWith(internalNamePrefix)) return;
    this._handleAlias(name);
    if (!this._data[name] || this._data[name].loaded) return;
    const module = await this._getModule(name);
    if(isStore){
      !this.Alpine.store(name) && this.Alpine.store(name, module);
    }
    else{
      this.Alpine.data(name, module);
    }
    
    this._data[name].loaded = true;
  },

  /**
   * =================================
   * store download
   * =================================
   */
  async _downloadStores(storeNames) {
    for (let name of storeNames) {
      await this._download(name, true);
    }
  },

  // run the callback function to get the module and find the appropriate import
  async _getModule(name) {
    if (!this._data[name]) return;

    const module = await this._data[name].download();

    // if the download function returns a function instead return that
    if (typeof module === 'function') return module;

    // work out which export to use in order of preference:
    // name; default; first export
    let whichExport = module[name] || module.default || Object.values(module)[0] || false;
    return whichExport;
  },

  /**
   * =================================
   * component activation
   * =================================
   * remove x-ignore attribute and the _x_ignore data property
   * them force Alpine to re-scan the tree
   */
  _activate(element) {
    element.removeAttribute(`${this._options.alpinePrefix}ignore`);
    // eslint-disable-next-line camelcase
    element._x_ignore = false;
    this.Alpine.initTree(element);
  },

  /**
   * =================================
   * mutation observer
   * =================================
   * watch for DOM mutations and set up added elements as new components
   */
  _mutations() {
    const observer = new MutationObserver(entries => {
      for (const entry of entries) {
        if (!entry.addedNodes) continue;
        for (const node of entry.addedNodes) {
          // only process element nodes
          if (node.nodeType !== 1) continue;

          // if the directly added node has ax-load then set it up
          if (node.hasAttribute(`${this._options.prefix}${this._options.root}`)) {
            this._mutationEl(node);
          }

          // check all descendants for ax-load
          const childComponents = node.querySelectorAll(`[${this._options.prefix}${this._options.root}]`);
          childComponents.forEach(el => this._mutationEl(el));
        }
      }
    });
    observer.observe(document, {
      attributes: true,
      childList: true,
      subtree: true,
    });
  },

  _mutationEl(el) {
    // if inline has been triggered and this element has inline src
    if (el.hasAttribute(`${this._options.prefix}${this._options.inline}`)) {
      this._inlineElement(el);
    }

    // setup component
    this._setupComponent(el);
  },

  /**
   * =================================
   * alias
   * =================================
   * if a component isn't specified allow for falling back to a url.
   * url should be provided as `/components/[name].js`
   */
  _handleAlias(name) {
    if (!this._alias || this._data[name]) return;
    // at this point alias is enabled and the component doesn't exist
    this.url(
      name,
      this._alias.replace('[name]', name)
    );
  },

  /**
   * =================================
   * helpers
   * =================================
   */
  // take x-data content to parse out name 'output("test")' becomes 'output'
  _parseName(attribute) {
    const parsedName = (attribute || '').split(/[({]/g)[0];
    const ourName = parsedName || `${internalNamePrefix}${this._index}`;
    return ourName;
  },

  _parseUrl(url) {
    // if the URL is relative then convert it to absolute based on the document baseURI
    // this is needed for when async alpine is loaded from a different origin than the page and component
    const absoluteReg = new RegExp('^(?:[a-z+]+:)?//', 'i');
    if (!absoluteReg.test(url)) {
      return new URL(url, document.baseURI).href;
    }

    return url;
  },
};

export { AsyncAlpine };
