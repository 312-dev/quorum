// Stand-in for Reddit's <shreddit-spoiler>, reduced to the contract the
// extension relies on (observed on www.reddit.com, 2026-10-24):
// - an open shadow root: <span class="outer" role="button"> around
//   <span class="inner"><slot></slot></span>, the inner hidden until revealed
// - embed-obscured is set while hidden; a click on .outer reveals and drops it
customElements.define(
  "shreddit-spoiler",
  class extends HTMLElement {
    connectedCallback() {
      if (this.shadowRoot) return;
      this.attachShadow({ mode: "open" }).innerHTML = `<style>
          .outer { background: #131313; border-radius: 2px; cursor: pointer; }
          .inner { opacity: 0; }
          .revealed.outer { background: none; }
          .revealed .inner { opacity: 1; }
        </style><span role="button" tabindex="0" class="outer" title="Reveal Spoiler"><span class="inner" aria-hidden="true"><slot></slot></span></span>`;
      this.setAttribute("embed-obscured", "");
      const outer = this.shadowRoot.querySelector(".outer");
      outer.addEventListener("click", () => {
        outer.classList.add("revealed");
        this.removeAttribute("embed-obscured");
      });
    }
  }
);
