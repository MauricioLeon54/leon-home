# LEÓN Home web design

The phone panel is a quiet instrument: it answers what is happening, what needs attention
and what you can do, in that order. It keeps the LEÓN identity from `docs/BRAND.md` and the
native app's motion scale from `docs/DESIGN.md`.

## Direction

- **One large moment per page.** Home opens with a single status sentence
  (“Everything is running” or “2 things need attention”) followed by only the issues.
  Network, Traffic and Ports open with their primary surface: the map, current traffic or
  the router's port panel.
- **Space and hairlines instead of cards.** Sections are separated by spacing and a 1 px
  rule. A filled surface is reserved for things you operate (the inspector, switch rows,
  dialogs, the update decision) or hardware (the port panel).
- **Everything visible, in order of importance.** Home reads: status, Internet, Pi-hole
  (with top domains and clients), Raspberry Pi (six readings and the 24 h temperature) beside
  Services, the home network, Tailscale beside backups, then the tablet. Pairs sit side by
  side from 560 px. Only long lists (“Show 4 more”) and method notes are collapsed; their open
  state survives refreshes.
- **Sentence case, no eyebrows.** Section titles are 17 px semibold Bone. Metadata is 13 px
  Ash and right-aligned in the section head.
- **Rounded numerals.** Readings use `ui-rounded` (SF Pro Rounded on iPhone and Mac) with
  tabular figures; all other text uses the system face. No web fonts are loaded.

## Colour has one meaning each

| Token           | Value     | Meaning                                                     |
| --------------- | --------- | ----------------------------------------------------------- |
| `--bg`          | `#0e0e0e` | Canvas                                                      |
| `--surface`     | `#161615` | Operable or hardware surface                                |
| `--raised`      | `#1d1d1b` | Sheet, dialog and map cards                                 |
| `--bone`        | `#eeeae3` | Primary text, primary action                                |
| `--ash`         | `#a39e94` | Secondary text, unknown and earlier readings                |
| `--good`        | `#75b891` | Current reading that is fine, enabled state                 |
| `--warn`        | `#d4a866` | Needs attention, destructive confirmation                   |
| `--down`/`--up` | blue/pink | Download and upload direction only — never latency or state |

Readings keep three visibly different states:

- **Current:** Bone value, filled green dot where a dot applies.
- **Earlier:** the value stays, labelled with its time (“Earlier scan 3:17 PM”); the page
  marks itself stale after 90 s without an answer and shows a connection notice.
- **Unknown:** an em dash or “No current reading” in Ash, and a hollow ring instead of a dot.

## Styles are Sass (`web/styles/`)

| File                         | Owns                                                                                |
| ---------------------------- | ----------------------------------------------------------------------------------- |
| `_tokens.scss`               | The only source of colours, type, radii, motion, breakpoints and `color()`          |
| `_root.scss`                 | Emits every token map as a CSS custom property (TypeScript reads motion)            |
| `_mixins.scss`               | `phone`, `narrow`, `wide`, `desktop`, `reduced-motion`, `hover`, helpers            |
| `_base.scss`                 | Reset, type, 44 px buttons, inputs, dots, badges, sections, readings, rows, tab bar |
| `_motion.scss`               | transitions.dev recipes: accordion, modal, text swap                                |
| `home.scss`, `updates.scss`  | Page entries                                                                        |
| `network-map.scss`, `map/_*` | Network view: chrome, topology, inspector, traffic, ports                           |

Use `color('name')` for colours (an unknown name fails the build), `var(--…)` for the other
tokens and the mixins for media queries. Never write a hex value outside `_tokens.scss`
except translucent tints derived from Bone or Obsidian. `scripts/build-web.mjs` compiles each
entry with the pinned `sass` package and minifies it with esbuild; the served names
(`home.css`, `network-map.css`, `updates.css`) and the release file list do not change. The
updates page loads `home.css` first, so `updates.scss` emits only its own layout.

`web/src/motion.ts` sequences the transitions: `openDialog`/`closeDialog`/`bindDialog`,
`swapText` for outcome messages and `bindDisclosures`/`setDisclosure` for collapsed sections.
Closed disclosure panels are `inert`, so hidden content is not focusable.

## Motion

All values come from the transitions.dev token scale in `_tokens.scss`.

| Interaction                   | Recipe                 | Timing                                         |
| ----------------------------- | ---------------------- | ---------------------------------------------- |
| Section change (tab bar)      | Page slide, enter only | 250 ms, 8 px rise, 3 px blur, smooth-out       |
| Device sheet (phones)         | Panel reveal           | open 400 ms, close 350 ms, 2 px blur           |
| Confirmations                 | Modal                  | open 250 ms from 0.96, close 150 ms            |
| Collapsed sections            | Accordion (grid rows)  | 250 ms both ways, chevron flip                 |
| Action outcomes, update state | Text swap              | 150 ms, 4 px, 2 px blur                        |
| Switch thumb, selection       | Position change        | 250 ms / 150 ms smooth-out                     |
| Pending action                | Opacity breathe        | 500 ms alternate, only while pending           |
| Devices arriving on the map   | Staggered reveal       | 400 ms, 8 px rise, 40 ms apart, 300 ms at most |
| Seen in the latest scan       | Presence ping          | 2.8 s from the rim dot, offset per device      |
| Router-reported traffic now   | Activity dots          | 1.2 s, three dots beside the rate              |

## Network map

The Network view is a topology diagram laid out by CSS, not a canvas: the router at the top
(drawn as the LEÓN mark; “Home network” when no router is identified) with a one-line summary,
a trunk, and one branch per connection the router reports (Ethernet, Wi-Fi 5 GHz, Wi-Fi 2.4 GHz,
Wi-Fi, not reported). Each branch holds a grid of device tiles, one full-width column on phones.
Nothing is positioned absolutely, so tiles never overlap, the inventory can grow, and the page
scrolls normally; there is no pan or zoom.

A tile shows a line drawing chosen from the declared kind (`phone`, `tablet`, `computer`, `tv`,
`speaker`, `printer`, `camera`, `console`, `watch`, `router`, `server`, `iot`, otherwise a
neutral chip; never from the name), the name, and either the presence or the current download
rate. The rim dot carries presence: green seen now, grey not seen, a ring for unknown. The only
repeating motion is a small ping from the green dot, offset per device, and three activity dots
beside a rate the router reports right now. Tiles are keyed by device and only moved when their
branch or order changes, so refreshes keep the rhythm, the selection and focus. One search field
filters tiles and branches; the trunk stops at the last visible branch.

Periodic refreshes never animate. They keep scroll position, keyboard focus, the selected
device, map positions, open sections and any form being edited. Nothing loops except an
explicit pending state. `prefers-reduced-motion: reduce` removes every transition and
animation; each recipe also carries its own guard.

## Honesty rules for the interface

- A control appears only when the server reports the capability (`canRename`, `canPause`,
  controllable ports). Protected ports stay visible but disabled with the reason.
- Destructive or connectivity-changing actions confirm first; enabling a port or resuming
  access acts at once. A switch shows the requested position only while pending; afterwards
  only a fresh router reading moves it. Nothing is retried automatically.
- Estimated or derived values say so (“not a speed test”, “Round-trip times measured by the
  Pi”). Opening Terminal or an external panel is never reported as a completed operation.

## Verification

Run `pnpm check`. For visual review, render the panel with synthetic data in Playwright
(Chromium and WebKit) at 320, 390 and 430 px and a desktop width, including locked,
offline, stale, empty, pending and dialog states. Never use real inventories or names in
screenshots.
