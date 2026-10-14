/* Shared display helpers for the three public research tools. */
window.ResearchTools = {
  number(value) {
    if ((typeof value !== "number" && typeof value !== "string") || (typeof value === "string" && !value.trim())) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  },
  escape(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"}[char]));
  },
  plain(value) {
    const text = String(value ?? "").replace(/<br\s*\/?\s*>|<\/(?:p|li|div)>/gi, "\n").replace(/<[^>]*>/g, "");
    const decoder = document.createElement("textarea"); decoder.innerHTML = text;
    return decoder.value.replace(/\n{3,}/g, "\n\n").trim();
  },
  url(value) {
    try { const url = new URL(String(value || ""), location.origin); return value && ["http:","https:"].includes(url.protocol) ? url.href : ""; } catch { return ""; }
  },
  text(id, value) { const element = document.getElementById(id); if (element) element.textContent = value; },
  updated(label = "已更新") {
    this.text("toolsStatus", label);
    this.text("toolsUpdatedAt", `取得於 ${new Intl.DateTimeFormat("zh-TW", {timeZone:"Asia/Taipei",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"}).format(new Date())}`);
  },
  async json(endpoint) {
    const response = await fetch(endpoint, {cache:"no-store"});
    if (!response.ok) throw new Error("Data unavailable");
    const data = await response.json(); if (data.error) throw new Error("Data unavailable"); return data;
  }
};
