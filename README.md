# Scorpious187's Token Mounting

Mount tokens onto other tokens. Built for **Foundry VTT v13**.

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
what you want. Where it is not, turn off **Grant Mount Ownership** in settings
and movement falls back to a GM relay — which requires a GM online and reinstates
the latency this design exists to avoid.

Prior ownership levels are recorded per user and restored exactly on dismount,
and a grant is only withdrawn once no remaining rider still justifies it — one
passenger stepping off will not strip control from the pilot still aboard.

## Usage

1. Select the token that will ride.
2. **Target** the token to ride (the same gesture as targeting for an attack).
3. Click the horse icon on the token HUD.

Dismount with the same button. Riders are seated automatically; with several
aboard they are laid out in rows across the mount's footprint.

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
```

Hooks: `scorpious187s-token-mounting.mounted` (rider, mount, seat, userId) and
`.dismounted` (rider, mount).

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

Untested in Foundry. Nothing here has run in a live world — the checks cover
syntax and pure geometry only. Chained mounts (a rider that is itself a mount)
are cycle-guarded but unexercised.
