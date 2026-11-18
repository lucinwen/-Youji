import { extractHTML } from "./htmlText";

// Defense in depth; parser input is never executable or passed to a resource loader.
for (const name of ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "importScripts"]) {
  Object.defineProperty(globalThis, name, {
    configurable: false,
    value: () => {
      throw new Error("网页解析禁止网络请求。");
    },
  });
}
const scope = globalThis as unknown as { onmessage: (event: MessageEvent<string>) => void; postMessage: (value: unknown) => void };
scope.onmessage = (event) => {
  try {
    scope.postMessage({ result: extractHTML(event.data) });
  } catch (error) {
    scope.postMessage({ error: error instanceof Error ? error.message : "网页解析失败。" });
  }
};
