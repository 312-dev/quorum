// Stand-in for Reddit's <shreddit-blurred-container>, reduced to the contract
// the extension relies on (observed on www.reddit.com, 2026-10-23):
// - reason="nsfw" mode="wrap" blurred: content sits in slot="revealed" under a
//   40px blur, with a pill button labelled "View NSFW content"
// - it renders asynchronously (Lit updates in a microtask)
// - embed-obscured is set while blurred; a click removes it and `blurred`
customElements.define(
  "shreddit-blurred-container",
  class extends HTMLElement {
    connectedCallback() {
      if (this.shadowRoot) return;
      this.attachShadow({ mode: "open" });
      if (this.hasAttribute("blurred")) this.setAttribute("embed-obscured", "");
      queueMicrotask(() => this.render());
      this.shadowRoot.addEventListener("click", () => {
        if (!this.hasAttribute("blurred")) return;
        this.removeAttribute("blurred");
        this.removeAttribute("embed-obscured");
        this.render();
      });
    }
    render() {
      const blurred = this.hasAttribute("blurred");
      this.shadowRoot.innerHTML = `<div class="outer" style="position:relative;overflow:hidden;border-radius:16px">
        ${blurred ? '<div class="overlay" style="position:absolute;inset:0;z-index:1;display:flex;align-items:center;justify-content:center"><button><span><span>View NSFW content</span></span></button></div>' : ""}
        <span class="inner" style="display:block;${blurred ? "filter:blur(40px);pointer-events:none" : ""}"><slot name="revealed"></slot></span>
      </div>`;
    }
  }
);
