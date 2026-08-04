# Scorpious187's Token Mounting

Mount tokens onto other tokens. Built on **Foundry VTT v13**'s token movement
system; verified on **v14**.

---

## Why this exists

Rideable does the same job, but has a structural problem. From
`FollowingScript.js:366`:

```js
if ((!game.users.find(vUser => vUser.isGM && vUser.active) && pToken.isOwner)
    || game.user.isGM) {
```

Follower movement executes **on the GM's client whenever a GM is online**, and
falls back to the token's owner only when no GM is connected. So every
player-piloted move round-trips through another person's browser, and the
strategy silently changes depending on who is logged in. That is where the
intermittent "piloting doesn't always work" behaviour comes from.

It also moves tokens with raw `token.update({x, y})`, which predates Foundry
v13's token movement system and bypasses the movement cost accounting that a
mount's speed depends on.

## How this differs

**The GM is in the rare path, not the frequent one.** Mounting changes actor
ownership, so it must be done by a GM — that happens once. Movement happens
constantly, and is a plain token update performed directly by the pilot. Piloting
behaves identically whether or not a GM is online.

**Riders are carried with a purpose-built movement action.** Foundry's built-in
`displace` has the right cost semantics but is `teleport: true`, so riders snap
to their destination while the mount is still animating there — visibly sitting
at the end of the *previous* move until it catches up. This module registers its
own action instead:

```js
teleport: false    // travel with the mount rather than snapping
measure: false     // a passenger spends none of their own movement
walls: null        // the mount already resolved walls
visualize: false   // no ruler for someone who is not steering
costMultiplier: 0  // riding costs nothing
```

Its `getAnimationOptions` reads the mount's current movement action and matches
its pace, so rider and mount stay locked together. A fixed speed would drift the
moment the mount does anything but walk or fly — `swim`, `crawl` and `climb` all
run at half speed, and teleporting actions at infinite.

**Riders replay the mount's path, not its destination.** Matching pace only keeps
two tokens together if they are covering the same ground, so the rider is given
the mount's actual route:

```js
Hooks.on('moveToken', (tokenDoc, movement) => { /* movement.passed.waypoints */ });
```

The obvious hook is `updateToken`, and it is the wrong one. It reports the
*fields that changed*, so a move arrives as a single new x/y — the endpoint,
with the route thrown away. A rider sent straight there cuts every corner the
mount rounded, and since a straight line is shorter than the path it replaces,
matching speed makes the rider arrive early and wait. `moveToken` hands over the
traversed waypoints instead, so the rider covers the same segments, the same
distance, in the same time. A chained passenger is offset from its own rider's
computed route rather than the root mount's, so it follows what it is actually
sitting on.

Auto-rotation is inherited rather than recomputed. Core resolves it from the
*method* of movement — a drag reads the **Token Auto-Rotate** core setting,
while an api move, which is what carrying and steering both issue, defaults it
to `false`. So the mount's decision is passed explicitly to its riders, and the
pilot's is passed to the mount it steers. Riders travel the mount's vector, so
turning when it turns keeps them facing the same way without copying its angle.

Only the waypoints someone *placed* are replayed. A processed movement path
interleaves those with `intermediate` steps Foundry generates along the direct
line between them, and core filters them out itself before treating a path as
user intent. Replaying them as real waypoints makes the rider crawl: each
generated step becomes a waypoint in its own right, Foundry generates further
steps between those, and the rider traces the route square by square while its
mount glides over the two or three corners that were actually drawn.

This matters more on some core versions than others. v13 and v14 batch movement
updates differently: on v13 they arrived finely enough that the straight hops
approximated the real path well enough to look right, and on v14 the whole route
collapses into one update, taking the approximation with it. Following the path
is the correct behaviour on both rather than a workaround for either.

**Mount speed governs the turn for free.** Because the pilot moves the *mount*
token, Foundry and dnd5e measure that movement against the mount's own speed.
Riding a dragon uses the dragon's speed with no special handling.

**One source of truth.** Only the rider stores a link
(`flags.<module>.mount = {tokenId, seat}`). A mount's riders are found by
scanning the scene, so there is no paired list to desynchronise and no orphaned
state to clean up.

## The ownership trade-off — read this

Foundry resolves token permission through the **actor**:
`TokenDocument#testUserPermission` delegates straight to
`Actor#testUserPermission`. There is no token-only permission to grant.

So granting a rider's owner control of the mount also gives them the mount's
character sheet, HP, and rolls. For a dragon its rider commands, that is usually
what you want.

Where it is not, turn off **Grant Mount Ownership** and nothing changes hands. A
GM then drives the mount, because Foundry will not let a player so much as select
a token they do not own — there is no client-side workaround for that, and this
module does not attempt one. Riders are still carried automatically in that mode,
by whichever client already owns each rider.

Prior ownership levels are recorded per user and restored exactly on dismount,
and a grant is only withdrawn once no remaining rider still justifies it — one
passenger stepping off will not strip control from the pilot still aboard.

## Usage

1. Select the token that will ride.
2. **Target** the token to ride (the same gesture as targeting for an attack).
3. Click the horse icon on the token HUD.

Dismount with the same button. Riders are seated automatically; with several
aboard they are laid out in rows across the mount's footprint.

Or turn on **Mount by Dragging Onto** for a token, and dragging anything onto it
mounts it — no targeting, no HUD. It is off by default and per-token on purpose:
if every mountable token were a drop target, walking a token across a stabled
horse would put it in the saddle.

### Steering

Once mounted, **drag the rider in seat 0 and the mount follows.** The pilot's
route is translated into the mount's frame and replayed there, so the mount
traces the shape that was drawn rather than a straight line to the end of it.

Seat 0 is whoever mounted first, since seats fill lowest-free-first, and it is
already the position seating.js treats as the driver's. Passengers are blocked
from moving rather than left free: the seat system would drag them back on the
mount's next move anyway, and a token that wanders off and then teleports back
reads as a bug rather than a rule.

Piloting the mount directly still works — this is an additional gesture, not a
replacement. Either way the mount is the token that moves, so the turn is
measured against the mount's speed.

### Per-token options

In **Token Config → Identity**, under *Mounting*:

| Option | Unset means |
|---|---|
| Rider Capacity | the world **Maximum Riders per Mount** setting |
| **Can Be Mounted** | **no — see below** |
| Mount by Dragging Onto | the world **Mount by Dragging** setting |
| Can Ride | yes |
| Grant Ownership on Mounting | the world **Grant Mount Ownership** setting |

They live on the TokenDocument rather than the actor, because two tokens of the
same actor can legitimately differ — the wagon being driven has seats, the one
parked in the background is scenery.

The three-way options are selects rather than checkboxes on purpose. A checkbox
cannot express "no opinion", so saving a token config once would pin every
option to whatever the box happened to show and detach it from the world setting
permanently.

### Mounts are opt-in

**Nothing is mountable until it is marked.** Mounts are the exception on a
populated scene, and an opt-out default would make every shopkeeper a legal
mount — and, with drag-to-mount on, a legal drop target.

That would be tedious if it meant a checkbox per horse, so it doesn't.
**Recognise Mounts on Creation** (on by default) checks a token's name against a
list as it is dropped on the scene, and marks a match as mountable:

```
horse, warhorse, steed, pony, mule, donkey, camel, elephant, mammoth,
rhinoceros, giant elk, giant goat, griffon, gryphon, hippogriff, pegasus,
wyvern, giant lizard, riding lizard, dire wolf, saddle
```

The list is editable in settings — clearing it restores these. Matching is on
whole words, so `horse` does not fire on *Horseshoe Crab*, and both the token
and actor names are checked, so a horse renamed *Bréagh* is still recognised
through its actor. Ambiguous creatures are deliberately absent: a false negative
costs one checkbox, a false positive means every wolf in the scene has quietly
become a drop target.

Detection only ever *adds* — a token whose **Can Be Mounted** has already been
set either way is left alone, and detection never sets drag-targeting, which
stays with the world setting.

> **Upgrading an existing world:** this is the one default that is not "behave as
> before". Tokens already placed have no flag, so they become unmountable until
> marked. Detection runs on creation, not retroactively.

### Subduing a hostile mount (dnd5e)

On dnd5e, two extra settings appear: **Hostile Mounts Require an Animal Handling
Check** and its **DC**. With it on, riding a token hostile to the rider prompts
an Animal Handling roll first; failing it, or dismissing the dialog, refuses the
mount. The roll happens on the *requesting* player's client, so whoever is
trying to control the animal is the one who sees the dice.

The settings are registered on every system but only shown on dnd5e — an Animal
Handling check is not a meaningful control in Fallout or PF2e.

That check is the only system-specific code in the module, and it is a client of
the same public gate anyone else can use. `validateMount` answers what can be
settled by inspecting state; anything needing dice or a question goes through
the async gate:

```js
const MODULE = 'scorpious187s-token-mounting';
const api = game.modules.get(MODULE).api;

Hooks.on(`${MODULE}.preMount`, (rider, mount, gate) => {
  if (!api.isHostile(rider, mount)) return;
  // Push a promise; resolving false denies the mount.
  gate.checks.push((async () => {
    const [roll] = (await rider.actor.rollSkill({ skill: 'ani' })) ?? [];
    return (roll?.total ?? 0) >= 15;
  })());
  gate.reason = 'The beast throws you off.';
});
```

Pushing a promise rather than returning one is what lets the hook stay
synchronous while the work behind it is not.

Seats are stored as fractions of the mount's own size rather than fixed grid
offsets, so they stay correct when a mount is resized and work on gridless
scenes — which matters if you are also running Battle Scene Scaling.

## Relationship to Battle Scene Scaling

None required. Battle Scene Scaling adjusts `system.attributes.movement.*` at the
data layer, so a scaled dragon's speed is already scaled by the time this module
reads it. No integration hook is needed unless testing proves otherwise.

## API

```js
const api = game.modules.get("scorpious187s-token-mounting").api;
await api.mount(riderTokenDoc, mountTokenDoc);
await api.dismount(riderTokenDoc);
api.getMount(riderTokenDoc);   // TokenDocument | null
api.getRiders(mountTokenDoc);  // TokenDocument[]
api.allRiders(mountTokenDoc);  // whole chain, nearest first
await api.resnap(mountTokenDoc);

api.isHostile(riderTokenDoc, mountTokenDoc);
api.pilotSeat;                 // the seat that steers (0)
api.options.capacityOf(mountTokenDoc);
api.options.isMountable(mountTokenDoc);
api.options.isRideable(riderTokenDoc);
api.options.acceptsDragMount(mountTokenDoc);
api.options.grantsOwnership(mountTokenDoc);
```

Hooks: `scorpious187s-token-mounting.mounted` (rider, mount, seat, userId),
`.dismounted` (rider, mount), and `.preMount` (rider, mount, gate) — see
*Gating a mount behind a check*.

## Building a local release

```powershell
.\build.ps1
.\build.ps1 -Version 0.2.0
```

Runs pre-flight checks (ESM syntax, JSON + BOM, localization keys, seat geometry)
and refuses to build on failure. Produces
`dist\scorpious187s-token-mounting-v<version>.zip` with `module.json` at the
archive root. Unzip on the server into:

```
<FoundryData>\Data\modules\scorpious187s-token-mounting\
```

## Status

Running in a live Foundry **v14** world. Mounting, piloting, steering from the
rider, carrying along a drawn path, and auto-rotation have all been exercised
there.

`compatibility` declares a minimum of v13: every API the module uses exists in
v13, and mounting and piloting did run there before the movement rewrite. That
rewrite has not been re-tested on v13, and `preMoveToken` — which steering and
drag-to-mount both depend on — is unconfirmed on that version. On v13, expect
carrying to work and check steering before relying on it.

Two things remain unexercised in a real world. Chained mounts (a rider that is
itself a mount) are cycle-guarded and covered by the offline harness but have
not been played. And rotating a mount *without* moving it does not turn its
riders — rotation is not a movement field, so that change never reaches the
movement hooks.
