export function qs(name) {
  return new URLSearchParams(location.search).get(name);
}
export function randomId() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}
export function wsUrl() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}`;
}
export function log(el, ...args) {
  const line = args
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ");
  console.log(...args);
  if (el) {
    el.textContent += line + "\n";
    el.scrollTop = el.scrollHeight;
  }
}
