/*!
 * <jarvis-orb> — animated cosmic AI orb (nucleus + 3 electron orbits)
 * Zero dependencies. Transparent background. Sized entirely by its parent.
 *
 *   <script src="jarvis-orb.js"></script>
 *   <div style="width:96px"><jarvis-orb state="idle"></jarvis-orb></div>
 *
 * Attributes (all optional, all live):
 *   state="idle|listening|thinking|speaking"   animation preset
 *   palette="patina|biolum|kiln|uvlab|frost"   colour set (or use core/mid/hot)
 *   auto-cycle="true|false"                    cross-fade through all palettes
 *   cycle-seconds="7"                          seconds per palette
 *   speed="1"                                  global motion multiplier
 *   trails="true|false"                        comet trails behind electrons
 *   core="#8fd6c0" mid="#b5643c" hot="#e8d8b8" explicit colours (override palette)
 *
 * Properties mirror the attributes: orb.state = 'listening'
 */
(function () {
  "use strict";

  var PALETTES = {
    patina: { name: "Patina & Copper", core: "#8fd6c0", mid: "#b5643c", hot: "#e8d8b8" },
    biolum: { name: "Bioluminescence", core: "#a8f0c6", mid: "#14556b", hot: "#f2a154" },
    kiln:   { name: "Ember Kiln",      core: "#ffc978", mid: "#c1442e", hot: "#6b2f52" },
    uvlab:  { name: "Ultraviolet Lab", core: "#e6e8e3", mid: "#7b3fe4", hot: "#b9f227" },
    frost:  { name: "Iron & Frost",    core: "#cfe3ec", mid: "#4a5b6b", hot: "#d98246" }
  };
  var ORDER = ["patina", "biolum", "kiln", "uvlab", "frost"];

  var PRESETS = {
    idle:      { spin: 7,   spin2: 5.2, spin3: 9,   pulse: 3.4, tilt: 9, aura: 14, nuc: 26, jitter: 4.2, quanta: 4.4, glow: 0.9,  ripple: 0,    rippleSpeed: 2 },
    listening: { spin: 4.4, spin2: 3.2, spin3: 5.6, pulse: 1.5, tilt: 6, aura: 9,  nuc: 16, jitter: 2.4, quanta: 2.6, glow: 1.2,  ripple: 0.55, rippleSpeed: 1.7 },
    thinking:  { spin: 1.5, spin2: 1.1, spin3: 2,   pulse: 1.1, tilt: 3, aura: 3,  nuc: 6,  jitter: 1.1, quanta: 1,   glow: 1.35, ripple: 0,    rippleSpeed: 2 },
    speaking:  { spin: 3,   spin2: 2.2, spin3: 3.8, pulse: 0.85, tilt: 5, aura: 6, nuc: 12, jitter: 1.6, quanta: 2,   glow: 1.25, ripple: 0.9,  rippleSpeed: 1.1 }
  };

  // Register the colour custom properties so they can cross-fade between palettes.
  if (window.CSS && CSS.registerProperty) {
    [["--jv-core", "#8fd6c0"], ["--jv-mid", "#b5643c"], ["--jv-hot", "#e8d8b8"]].forEach(function (p) {
      try { CSS.registerProperty({ name: p[0], syntax: "<color>", inherits: true, initialValue: p[1] }); } catch (e) {}
    });
  }

  var mix = function (v, pct, other) {
    return "color-mix(in oklab, var(" + v + ") " + pct + "%, " + (other || "transparent") + ")";
  };

  var CSS_TEXT = [
    ":host{display:block;position:relative;width:100%;line-height:0}",
    ".stage{position:relative;width:100%;aspect-ratio:1;container-type:inline-size}",
    ".layer{position:absolute;inset:0;transition:--jv-core var(--jv-fade,2.4s) ease-in-out,--jv-mid var(--jv-fade,2.4s) ease-in-out,--jv-hot var(--jv-fade,2.4s) ease-in-out}",
    ".dot{position:absolute;border-radius:50%;aspect-ratio:1}",
    "@keyframes jv-spin{to{transform:rotateZ(360deg)}}",
    "@keyframes jv-spin-rev{to{transform:rotateZ(-360deg)}}",
    "@keyframes jv-tilt{0%,100%{transform:rotateZ(-7deg) rotateX(3deg)}50%{transform:rotateZ(7deg) rotateX(-3deg)}}",
    "@keyframes jv-pulse{0%,100%{transform:translate(-50%,-50%) scale(1)}50%{transform:translate(-50%,-50%) scale(1.1)}}",
    "@keyframes jv-breathe{0%,100%{opacity:.5;transform:translate(-50%,-50%) scale(1)}50%{opacity:.95;transform:translate(-50%,-50%) scale(1.22)}}",
    "@keyframes jv-ripple{0%{transform:scale(.6);opacity:0}12%{opacity:var(--jv-ripple,0)}100%{transform:scale(1.48);opacity:0}}",
    "@keyframes jv-aura{to{transform:rotate(360deg)}}",
    "@keyframes jv-aura-rev{to{transform:rotate(-360deg)}}",
    "@keyframes jv-flicker{0%,100%{opacity:.95}37%{opacity:.5}62%{opacity:1}84%{opacity:.7}}",
    "@keyframes jv-jitter-a{0%,100%{transform:translate(0,0)}33%{transform:translate(4%,-5%)}66%{transform:translate(-3%,4%)}}",
    "@keyframes jv-jitter-b{0%,100%{transform:translate(0,0)}40%{transform:translate(-5%,-3%)}75%{transform:translate(3%,5%)}}",
    "@keyframes jv-shell{0%,100%{opacity:.22}50%{opacity:.5}}",
    "@media (prefers-reduced-motion:reduce){.layer *{animation-duration:calc(var(--jv-rm,1) * 40s)!important}}"
  ].join("");

  var ORBITS = [
    { rot: 0,   ring: "--jv-core", trailFrom: "8", trailTo: "55", anim: "jv-spin",     dur: "--jv-spin",  big: { c: "--jv-core", s: 5.6, dark: "#0b1418" }, small: { c: "--jv-hot", s: 4.2 }, ringPct: 40 },
    { rot: 60,  ring: "--jv-hot",  trailFrom: "50", trailTo: "8", anim: "jv-spin-rev", dur: "--jv-spin2", big: { c: "--jv-hot", s: 5.2, dark: "#1a1008" }, small: { c: "--jv-mid", s: 3.8 }, ringPct: 34 },
    { rot: 120, ring: "--jv-mid",  trailFrom: "10", trailTo: "52", anim: "jv-spin",    dur: "--jv-spin3", big: { c: "--jv-mid", s: 5.0, dark: "#12080c" }, small: { c: "--jv-core", s: 3.6 }, ringPct: 42 }
  ];

  var NUCLEONS = [
    { l: 32, t: 30, w: 40, c: "--jv-hot",  dark: "#241608", a: "jv-jitter-a", d: 0 },
    { l: 6,  t: 24, w: 36, c: "--jv-core", dark: "#0d1a1c", a: "jv-jitter-b", d: 0.4 },
    { l: 44, t: 6,  w: 33, c: "--jv-mid",  dark: "#150a10", a: "jv-jitter-b", d: 1.1 },
    { l: 14, t: 56, w: 34, c: "--jv-mid",  dark: "#150a10", a: "jv-jitter-a", d: 1.7 },
    { l: 50, t: 52, w: 38, c: "--jv-core", dark: "#08161a", a: "jv-jitter-b", d: 2.3 },
    { l: 26, t: 42, w: 30, c: "--jv-hot",  dark: "#241608", a: "jv-jitter-a", d: 2.9 }
  ];

  function orbitHTML(o) {
    var ringMask = "radial-gradient(closest-side, transparent 96%, #000 98%)";
    var sphere = function (v, dark) {
      return "radial-gradient(circle at 34% 30%, #fff 0%, " + mix(v, 55, "#ffffff") + " 24%, var(" + v + ") 68%, " + mix(v, 58, dark) + " 100%)";
    };
    var glint = function (v) {
      return "radial-gradient(circle at 36% 30%, #fff 0%, " + mix(v, 66, "#ffffff") + " 40%, var(" + v + ") 100%)";
    };
    return '' +
      '<div style="position:absolute;inset:8%;transform-style:preserve-3d;transform:rotateZ(' + o.rot + 'deg) rotateX(66deg)">' +
        '<div style="position:absolute;inset:0;border-radius:50%;border:max(0.7px,.3cqw) solid ' + mix(o.ring, o.ringPct) + ';box-shadow:0 0 2.4cqw ' + mix(o.ring, 18) + ', inset 0 0 1.8cqw ' + mix(o.ring, 10) + '"></div>' +
        '<div style="position:absolute;inset:0;border-radius:50%;background:conic-gradient(from 0deg, ' + mix(o.ring, o.trailFrom) + ' 0deg, transparent 120deg, transparent 240deg, ' + mix(o.ring, o.trailTo) + ' 358deg);mask:' + ringMask + ';-webkit-mask:' + ringMask + ';opacity:var(--jv-trail,1)"></div>' +
        '<div style="position:absolute;inset:0;animation:' + o.anim + ' var(' + o.dur + ') linear infinite">' +
          '<div class="dot" style="top:50%;left:-' + (o.big.s / 2) + '%;width:' + o.big.s + '%;margin-top:-' + (o.big.s / 2) + '%;background:' + sphere(o.big.c, o.big.dark) + ';box-shadow:0 0 2cqw var(' + o.big.c + '), 0 0 6cqw ' + mix(o.big.c, 45) + '"></div>' +
          '<div class="dot" style="top:50%;right:-' + (o.small.s / 2) + '%;width:' + o.small.s + '%;margin-top:-' + (o.small.s / 2) + '%;background:' + glint(o.small.c) + ';box-shadow:0 0 1.6cqw ' + mix(o.small.c, 80) + ', 0 0 4.5cqw ' + mix(o.small.c, 35) + '"></div>' +
        '</div>' +
      '</div>';
  }

  function nucleonHTML(n) {
    return '<div class="dot" style="left:' + n.l + '%;top:' + n.t + '%;width:' + n.w + '%;background:radial-gradient(circle at 33% 28%, #fff 0%, ' + mix(n.c, 55, "#ffffff") + ' 27%, var(' + n.c + ') 66%, ' + mix(n.c, 60, n.dark) + ' 100%);animation:' + n.a + ' var(--jv-jitter,4.2s) ease-in-out infinite;animation-delay:' + n.d + 's"></div>';
  }

  var AURA_MASK = "radial-gradient(closest-side, transparent 84%, #000 90%, #000 97%, transparent 100%)";

  var MARKUP = '' +
    '<div class="stage"><div class="layer">' +
      '<div style="position:absolute;inset:-6%;border-radius:50%;background:radial-gradient(circle at 50% 50%, ' + mix("--jv-core", 22) + ' 0%, ' + mix("--jv-mid", 12) + ' 44%, transparent 70%);filter:blur(5cqw);opacity:var(--jv-glow,1)"></div>' +
      '<div style="position:absolute;inset:2%;border-radius:50%;background:conic-gradient(from 0deg, transparent 0deg, ' + mix("--jv-hot", 55) + ' 26deg, transparent 62deg, transparent 150deg, ' + mix("--jv-core", 50) + ' 196deg, transparent 232deg, ' + mix("--jv-mid", 55) + ' 318deg, transparent 348deg);mask:' + AURA_MASK + ';-webkit-mask:' + AURA_MASK + ';animation:jv-aura var(--jv-aura,14s) linear infinite;opacity:.8;filter:blur(.5cqw)"></div>' +
      '<div style="position:absolute;inset:11%;border-radius:50%;border:max(0.5px,.15cqw) dashed ' + mix("--jv-core", 30) + ';animation:jv-aura-rev var(--jv-aura,14s) linear infinite;opacity:.5"></div>' +
      '<div style="position:absolute;inset:22%;border-radius:50%;background:radial-gradient(circle at 30% 26%, ' + mix("--jv-core", 26) + ' 0%, transparent 62%);animation:jv-shell var(--jv-pulse,3.4s) ease-in-out infinite;filter:blur(1.4cqw)"></div>' +
      '<div style="position:absolute;inset:0;border-radius:50%;border:max(0.7px,.3cqw) solid ' + mix("--jv-core", 24) + ';animation:jv-ripple var(--jv-ripplespeed,1.6s) ease-out infinite;opacity:0"></div>' +
      '<div style="position:absolute;inset:0;border-radius:50%;border:max(0.7px,.3cqw) solid ' + mix("--jv-hot", 24) + ';animation:jv-ripple var(--jv-ripplespeed,1.6s) ease-out infinite;animation-delay:.53s;opacity:0"></div>' +
      '<div style="position:absolute;inset:0;border-radius:50%;border:max(0.7px,.3cqw) solid ' + mix("--jv-mid", 24) + ';animation:jv-ripple var(--jv-ripplespeed,1.6s) ease-out infinite;animation-delay:1.06s;opacity:0"></div>' +
      '<div style="position:absolute;inset:0;perspective:320cqw;transform-style:preserve-3d;animation:jv-tilt var(--jv-tilt,9s) ease-in-out infinite">' +
        ORBITS.map(orbitHTML).join("") +
      '</div>' +
      '<div style="position:absolute;top:50%;left:50%;width:42%;aspect-ratio:1;border-radius:50%;background:radial-gradient(circle at 40% 34%, ' + mix("--jv-core", 55, "#ffffff") + ' 0%, var(--jv-mid) 44%, ' + mix("--jv-hot", 40, "#140d16") + ' 78%, transparent 100%);filter:blur(2cqw);animation:jv-breathe var(--jv-pulse,3.4s) ease-in-out infinite"></div>' +
      '<div style="position:absolute;top:50%;left:50%;width:26%;aspect-ratio:1;transform:translate(-50%,-50%);animation:jv-aura var(--jv-nucspin,26s) linear infinite">' +
        '<div style="position:absolute;inset:0;border-radius:50%;box-shadow:0 0 5cqw ' + mix("--jv-mid", 45) + ', 0 0 12cqw ' + mix("--jv-core", 22) + '"></div>' +
        NUCLEONS.map(nucleonHTML).join("") +
      '</div>' +
      '<div style="position:absolute;top:50%;left:50%;width:30%;aspect-ratio:1;border-radius:50%;background:radial-gradient(circle at 36% 30%, rgba(255,255,255,.5) 0%, rgba(255,255,255,.12) 22%, transparent 58%);transform:translate(-50%,-50%);mix-blend-mode:screen;filter:blur(.5cqw);animation:jv-flicker var(--jv-pulse,3.4s) ease-in-out infinite"></div>' +
      '<div style="position:absolute;inset:16%;animation:jv-spin var(--jv-quanta,2.6s) linear infinite">' +
        '<div class="dot" style="top:50%;left:0;width:1.8%;margin-top:-.9%;background:#fff;box-shadow:0 0 1.4cqw var(--jv-core);opacity:.85"></div>' +
        '<div class="dot" style="top:8%;left:74%;width:1.4%;background:#fff;box-shadow:0 0 1.2cqw var(--jv-hot);opacity:.7"></div>' +
      '</div>' +
    '</div></div>';

  var OBSERVED = ["state", "palette", "auto-cycle", "cycle-seconds", "speed", "trails", "core", "mid", "hot"];

  var JarvisOrb = function () {};
  JarvisOrb = class JarvisOrb extends HTMLElement {
    static get observedAttributes() { return OBSERVED; }

    constructor() {
      super();
      var root = this.attachShadow({ mode: "open" });
      var style = document.createElement("style");
      style.textContent = CSS_TEXT;
      root.appendChild(style);
      var host = document.createElement("div");
      host.innerHTML = MARKUP;
      root.appendChild(host);
      this._layer = root.querySelector(".layer");
      this._i = 0;
    }

    connectedCallback() { this._apply(); }
    disconnectedCallback() { clearInterval(this._timer); this._timer = null; }
    attributeChangedCallback() { if (this.isConnected) this._apply(); }

    _attr(name, fallback) {
      var v = this.getAttribute(name);
      return v === null || v === "" ? fallback : v;
    }

    _apply() {
      var el = this._layer;
      if (!el) return;

      var preset = PRESETS[this._attr("state", "idle")] || PRESETS.idle;
      var k = parseFloat(this._attr("speed", "1")) || 1;
      var d = function (v) { return (v / k).toFixed(2) + "s"; };

      var auto = this._attr("auto-cycle", "true") !== "false";
      var secs = parseFloat(this._attr("cycle-seconds", "7")) || 7;
      var baseId = PALETTES[this._attr("palette", "patina")] ? this._attr("palette", "patina") : "patina";
      var start = ORDER.indexOf(baseId);
      var pal = PALETTES[auto ? ORDER[(start + this._i) % ORDER.length] : baseId];

      el.style.setProperty("--jv-fade", Math.min(2.6, secs / 3).toFixed(2) + "s");
      el.style.setProperty("--jv-core", this._attr("core", pal.core));
      el.style.setProperty("--jv-mid", this._attr("mid", pal.mid));
      el.style.setProperty("--jv-hot", this._attr("hot", pal.hot));
      el.style.setProperty("--jv-spin", d(preset.spin));
      el.style.setProperty("--jv-spin2", d(preset.spin2));
      el.style.setProperty("--jv-spin3", d(preset.spin3));
      el.style.setProperty("--jv-pulse", d(preset.pulse));
      el.style.setProperty("--jv-tilt", d(preset.tilt));
      el.style.setProperty("--jv-aura", d(preset.aura));
      el.style.setProperty("--jv-nucspin", d(preset.nuc));
      el.style.setProperty("--jv-jitter", d(preset.jitter));
      el.style.setProperty("--jv-quanta", d(preset.quanta));
      el.style.setProperty("--jv-glow", preset.glow);
      el.style.setProperty("--jv-ripple", preset.ripple);
      el.style.setProperty("--jv-ripplespeed", d(preset.rippleSpeed));
      el.style.setProperty("--jv-trail", this._attr("trails", "true") === "false" ? 0 : 1);

      clearInterval(this._timer);
      this._timer = null;
      if (auto && !this.hasAttribute("core")) {
        var self = this;
        this._timer = setInterval(function () { self._i++; self._apply(); }, secs * 1000);
      }
    }

    /** Names of the built-in palettes. */
    static get palettes() { return Object.keys(PALETTES).map(function (id) { return { id: id, name: PALETTES[id].name }; }); }
  };

  OBSERVED.forEach(function (attr) {
    var prop = attr.replace(/-([a-z])/g, function (_, c) { return c.toUpperCase(); });
    Object.defineProperty(JarvisOrb.prototype, prop, {
      get: function () { return this.getAttribute(attr); },
      set: function (v) {
        if (v === null || v === false) this.removeAttribute(attr);
        else this.setAttribute(attr, v);
      }
    });
  });

  if (!customElements.get("jarvis-orb")) customElements.define("jarvis-orb", JarvisOrb);
  window.JarvisOrb = JarvisOrb;
})();
