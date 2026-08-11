# &lt;jarvis-orb&gt;

Animated cosmic AI icon — a nucleus of six protons/neutrons inside three tilted
electron orbits, with comet trails, energy aura and quanta sparks. One file, no
dependencies, transparent background, scales from 32px to full screen.

## Install

Copy `jarvis-orb.js` into your project and load it once:

```html
<script src="/assets/jarvis-orb.js"></script>
```

## Use

The orb fills its parent, so the parent controls the size:

```html
<div style="width: 96px">
  <jarvis-orb state="idle"></jarvis-orb>
</div>
```

Drive it from your app — attributes and properties both work, changes apply live:

```js
const orb = document.querySelector('jarvis-orb');
orb.state = 'listening';   // idle | listening | thinking | speaking
```

## Attributes

| Attribute | Values | Default | Notes |
|---|---|---|---|
| `state` | `idle` `listening` `thinking` `speaking` | `idle` | animation preset |
| `palette` | `patina` `biolum` `kiln` `uvlab` `frost` | `patina` | starting colour set |
| `auto-cycle` | `true` `false` | `true` | cross-fades through all five palettes |
| `cycle-seconds` | number | `7` | seconds per palette |
| `speed` | `0.3`–`3` | `1` | global motion multiplier |
| `trails` | `true` `false` | `true` | comet trails behind electrons |
| `core` / `mid` / `hot` | any CSS colour | — | your own colours; setting `core` disables cycling |

Every attribute is mirrored as a JS property (`autoCycle`, `cycleSeconds`, …).
`JarvisOrb.palettes` returns the built-in palette list.

## Palettes

| id | name | colours |
|---|---|---|
| `patina` | Patina & Copper | `#8fd6c0` `#b5643c` `#e8d8b8` |
| `biolum` | Bioluminescence | `#a8f0c6` `#14556b` `#f2a154` |
| `kiln` | Ember Kiln | `#ffc978` `#c1442e` `#6b2f52` |
| `uvlab` | Ultraviolet Lab | `#e6e8e3` `#7b3fe4` `#b9f227` |
| `frost` | Iron & Frost | `#cfe3ec` `#4a5b6b` `#d98246` |

## Notes

- Designed for **dark** surfaces; the background is fully transparent.
- Pure CSS animation — no canvas, no rAF loop, no repaint cost when off-screen.
- Colour cross-fades use registered custom properties (`@property`); in browsers
  without support the colours switch instantly instead of fading.
- Honours `prefers-reduced-motion`.
- `index.html` is a live usage sheet — open it to see every state and size.
