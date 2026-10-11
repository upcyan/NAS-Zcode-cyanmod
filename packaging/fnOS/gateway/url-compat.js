// ZCode Web 前端 —— fnOS 统一网关子路径兼容层。
//
// 为什么需要：ZCode Web 构建产物把同源资源与接口写成**根绝对路径**
// （HTML 里 /assets/…、Vite preload helper 里的 `/`+路径、运行期的
//  fetch("/api/server-info")、new WebSocket("/ws")…）。而飞牛统一网关把本应用
// 挂在 /app/zcode 前缀下，根绝对路径会逃出前缀、打到面板自身（404 或串到别的应用）。
//
// 本脚本在**页面最早期**注入，接管所有"产生请求 URL"的入口，把同源根绝对路径
// 重写为网关前缀下的路径。动态 import("./xxx.js") 是相对**模块 URL** 解析的，
// 天然落在 /app/zcode/assets/ 下，不需要也不应该改写（改写反而会破坏它）。
//
// 与 fnOS 面板自身路径的关系：/app/、/_fnos/、/__fnos/ 一律原样放行，
// 否则会把面板接口、网关自身资源也拖进本应用前缀。
(function () {
  "use strict";
  var PREFIX = (document.currentScript && document.currentScript.dataset.prefix) || "/app/zcode";
  if (globalThis.__ZCODE_GATEWAY_PREFIX__ === PREFIX) return;
  // 只在网关子路径下生效：局域网直连（http://<ip>:8988/…）时根路径本来就是对的，
  // 改写反而会把它推进 /app/zcode。这也是本层不必按访问方式分别构建的原因。
  // 用 startsWith 判断而非整段相等，因为入口可能是 /app/zcode、/app/zcode/、/app/zcode/<子路由>。
  if (location.pathname !== PREFIX && location.pathname.indexOf(PREFIX + "/") !== 0) return;
  globalThis.__ZCODE_GATEWAY_PREFIX__ = PREFIX;

  /** 已在网关前缀内 / 面板自身命名空间 / 跨源 —— 一律不改写 */
  function skip(pathname) {
    return (
      pathname === PREFIX ||
      pathname.indexOf(PREFIX + "/") === 0 ||
      pathname.indexOf("/app/") === 0 ||
      pathname.indexOf("/_fnos/") === 0 ||
      pathname.indexOf("/__fnos/") === 0
    );
  }

  function mapPath(pathname) {
    if (!pathname || pathname.charAt(0) !== "/" || pathname.indexOf("//") === 0) return pathname;
    if (skip(pathname)) return pathname;
    return PREFIX + pathname;
  }

  /** 把单个 URL（相对/绝对/协议相对）映射到网关前缀下 */
  function route(value) {
    if (typeof value !== "string" || value === "") return value;
    // 根绝对路径：就地改写，保留 query / hash
    if (value.charAt(0) === "/" && value.indexOf("//") !== 0) {
      if (skip(value)) return value;
      var q = value.search(/[?#]/);
      var pathname = q === -1 ? value : value.slice(0, q);
      var rest = q === -1 ? "" : value.slice(q);
      return mapPath(pathname) + rest;
    }
    // 带 origin 的绝对 URL：只处理同源；跨源（zcode.z.ai 等外部接口）原样放行
    try {
      var url = new URL(value, location.href);
      var sameOrigin =
        url.origin === location.origin ||
        ((url.protocol === "ws:" || url.protocol === "wss:") && url.host === location.host);
      if (!sameOrigin) return value;
      if (skip(url.pathname)) return value;
      url.pathname = mapPath(url.pathname);
      if (url.protocol === "ws:" && location.protocol === "https:") url.protocol = "wss:";
      return url.href;
    } catch (e) {
      return value;
    }
  }

  // ── fetch ────────────────────────────────────────────────────────────────
  var nativeFetch = globalThis.fetch;
  if (typeof nativeFetch === "function") {
    globalThis.fetch = function (input, init) {
      try {
        if (typeof input === "string") input = route(input);
        else if (typeof URL !== "undefined" && input instanceof URL) input = route(input.href);
        else if (typeof Request !== "undefined" && input instanceof Request) {
          var target = route(input.url);
          if (target !== input.url) input = new Request(target, input);
        }
      } catch (e) {
        /* 改写失败就按原样发，别把请求整个弄丢 */
      }
      return nativeFetch.call(this, input, init);
    };
  }

  // ── XMLHttpRequest ───────────────────────────────────────────────────────
  if (typeof XMLHttpRequest !== "undefined" && XMLHttpRequest.prototype.open) {
    var nativeOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      var args = Array.prototype.slice.call(arguments);
      try {
        args[1] = route(url);
      } catch (e) {}
      return nativeOpen.apply(this, args);
    };
  }

  // ── EventSource / Worker / SharedWorker ──────────────────────────────────
  // WebSocket 单独在下方处理（它还要挂断线自愈）。这里不要把它一起包，
  // 否则会被双重 Proxy 包装。
  ["EventSource", "Worker", "SharedWorker"].forEach(function (name) {
    var Native = globalThis[name];
    if (typeof Native !== "function") return;
    globalThis[name] = new Proxy(Native, {
      construct: function (target, args, newTarget) {
        try {
          if (args.length) args[0] = route(args[0] instanceof URL ? args[0].href : args[0]);
        } catch (e) {}
        return Reflect.construct(target, args, newTarget);
      },
    });
  });

  // ── 断线自愈 ─────────────────────────────────────────────────────────────
  // ZCode 前端自带的「重连」只由服务端 agent 生命周期事件驱动
  // （onAgentRuntimeLifecycle / onAgentRuntimeRestarted）。网关重启、面板重载、
  // 网络抖动这类**纯连接断开**不会触发它 —— 前端只是把 close 抛给上层。
  // 表现就是：页面看着一切正常，但发送消息、上传附件全部无声卡住（一直转圈）。
  //
  // 这里在传输层兜底：只处理「已经建立过、然后意外断开」的连接（wasOpen 为真），
  // 等一小会儿探测服务是否已恢复；恢复则重载页面，未恢复则持续重试并提示。
  //
  // 为什么是重载而不是就地重连：服务端按连接维护订阅，换一条连接等于订阅全丢，
  // 就地重连只会变成「看着连上了、其实收不到任何推送」，比重载更隐蔽也更糟。
  // 应用主动 close（dispose/logout）不触发自愈。
  (function () {
    var RECOVER_DELAY_MS = 3000;
    var MAX_WAIT_MS = 5 * 60 * 1000;

    var recovering = false;
    var startedAt = 0;

    function banner(text) {
      var id = "__zcode_gw_recover__";
      var el = document.getElementById(id);
      if (!el) {
        el = document.createElement("div");
        el.id = id;
        el.style.cssText =
          "position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:2147483647;" +
          "padding:8px 16px;border-radius:8px;font:13px/1.5 system-ui,sans-serif;" +
          "background:#3b3b3b;color:#eee;box-shadow:0 4px 16px rgba(0,0,0,.35);pointer-events:none";
        (document.body || document.documentElement).appendChild(el);
      }
      el.textContent = text;
    }

    /** 服务是否已恢复；no-store 避免命中缓存得出假阳性 */
    function probe() {
      return fetch(PREFIX + "/", { method: "GET", cache: "no-store" })
        .then(function (res) { return res.ok; })
        .catch(function () { return false; });
    }

    function waitAndReload() {
      if (Date.now() - startedAt > MAX_WAIT_MS) {
        banner("与服务断开，请手动刷新页面");
        return;
      }
      probe().then(function (ok) {
        if (ok) {
          banner("连接已恢复，正在刷新…");
          setTimeout(function () { location.reload(); }, 300);
          return;
        }
        banner("与服务断开，正在重试…");
        setTimeout(waitAndReload, RECOVER_DELAY_MS);
      });
    }

    function recover() {
      if (recovering) return;
      recovering = true;
      startedAt = Date.now();
      banner("与服务断开，正在恢复…");
      setTimeout(waitAndReload, RECOVER_DELAY_MS);
    }

    var NativeWS = globalThis.WebSocket;
    if (typeof NativeWS === "function") {
      globalThis.WebSocket = new Proxy(NativeWS, {
        construct: function (target, args, newTarget) {
          try {
            if (args.length) args[0] = route(args[0] instanceof URL ? args[0].href : args[0]);
          } catch (e) {}
          var ws = Reflect.construct(target, args, newTarget);
          try {
            var appClosed = false;
            var wasOpen = false;
            var nativeClose = ws.close;
            Object.defineProperty(ws, "close", {
              configurable: true,
              writable: true,
              value: function () {
                appClosed = true;
                return nativeClose.apply(ws, arguments);
              },
            });
            ws.addEventListener("open", function () { wasOpen = true; });
            ws.addEventListener("close", function () { if (!appClosed && wasOpen) recover(); });
            ws.addEventListener("error", function () { if (!appClosed && wasOpen) recover(); });
          } catch (e) {}
          return ws;
        },
      });
    }
  })();

  // ── 动态插入的资源元素 ───────────────────────────────────────────────────
  // Vite 的 modulepreload helper 走 `link.href = "/" + path`，绕开 fetch/XHR，
  // 只能拦属性赋值与 setAttribute。
  function wrapResourceProperty(type, name) {
    if (typeof type !== "function") return;
    var descriptor = Object.getOwnPropertyDescriptor(type.prototype, name);
    if (!descriptor || !descriptor.configurable || typeof descriptor.set !== "function") return;
    Object.defineProperty(type.prototype, name, {
      configurable: true,
      enumerable: descriptor.enumerable,
      get: descriptor.get,
      set: function (value) {
        return descriptor.set.call(this, route(value));
      },
    });
  }
  wrapResourceProperty(globalThis.HTMLScriptElement, "src");
  wrapResourceProperty(globalThis.HTMLLinkElement, "href");
  wrapResourceProperty(globalThis.HTMLImageElement, "src");

  if (typeof Element !== "undefined" && Element.prototype.setAttribute) {
    var nativeSetAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
      var lower = String(name).toLowerCase();
      var isResource =
        (this instanceof HTMLScriptElement && lower === "src") ||
        (this instanceof HTMLLinkElement && lower === "href") ||
        (this instanceof HTMLImageElement && lower === "src");
      return nativeSetAttribute.call(this, name, isResource ? route(value) : value);
    };
  }

  // ── 其他出口 ─────────────────────────────────────────────────────────────
  if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
    var nativeBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) {
      return nativeBeacon(route(url), data);
    };
  }

  // 站内链接（如 OAuth 回跳、分享页）在点击时补齐前缀，避免跳出网关。
  document.addEventListener(
    "click",
    function (event) {
      var anchor = event.target && event.target.closest && event.target.closest("a[href]");
      if (!anchor) return;
      var href = anchor.getAttribute("href");
      if (!href) return;
      var next = route(href);
      if (next !== href) anchor.setAttribute("href", next);
    },
    true,
  );
})();
