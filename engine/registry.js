/* UVCore module registry.
 *
 * The geometry kernel is written as plain-JS module factories with NO
 * dependency on the DOM or Three.js, so exactly the same code can run:
 *   - on the main thread            (UVCore.build())
 *   - inside a Web Worker            (worker source is generated from the
 *                                     factories' own source text, so it works
 *                                     even when the page is opened via file://
 *                                     where fetch/importScripts are blocked)
 *   - under `node --test`            (tests/load-core.js requires the files)
 *
 * Usage in a module file:
 *   UVCore.define('mesh', function (C) {
 *     // C holds the exports of every module defined before this one
 *     function weldMesh(...) { ... }
 *     return { weldMesh };
 *   });
 *
 * Factories must be self-contained: no references to variables outside the
 * factory other than `C`, standard globals (Math, Float32Array, ...) and
 * `UVCore` itself. Anything else would break when the source is re-evaluated
 * inside a worker.
 */
(function (root) {
  'use strict';
  if (root.UVCore) return;

  /* `bootstrap` is the registry. It is a named function with no free
   * variables so that source() can serialise it verbatim for a Worker. */
  function bootstrap(root) {
    'use strict';
    var modules = [];

    function define(name, factory) {
      if (typeof name !== 'string' || typeof factory !== 'function') {
        throw new Error('UVCore.define(name, factory) expects a string and a function');
      }
      for (var i = 0; i < modules.length; i++) {
        if (modules[i].name === name) { modules[i].factory = factory; return; }
      }
      modules.push({ name: name, factory: factory });
    }

    function build() {
      var C = { __modules: [] };
      for (var i = 0; i < modules.length; i++) {
        var exportsObj = modules[i].factory(C) || {};
        var keys = Object.keys(exportsObj);
        for (var k = 0; k < keys.length; k++) C[keys[k]] = exportsObj[keys[k]];
        C.__modules.push(modules[i].name);
      }
      return C;
    }

    function names() { return modules.map(function (m) { return m.name; }); }

    /* Source text that recreates the registry + every defined module.
     * Evaluating it in a fresh realm and calling UVCore.build() yields an
     * identical kernel. */
    function source() {
      var out = ['(' + bootstrap.toString() + ')(typeof self !== "undefined" ? self : globalThis);'];
      for (var i = 0; i < modules.length; i++) {
        out.push('UVCore.define(' + JSON.stringify(modules[i].name) + ', ' + modules[i].factory.toString() + ');');
      }
      return out.join('\n\n');
    }

    root.UVCore = { define: define, build: build, names: names, source: source };
  }

  bootstrap(root);
})(typeof self !== 'undefined' ? self : globalThis);
