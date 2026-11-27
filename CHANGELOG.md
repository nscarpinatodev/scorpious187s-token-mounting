# Changelog

## 0.6.1

Dismounting from an unlinked mount no longer leaves a copy of its ownership behind.

- An unlinked token takes its ownership from its actor unless it holds its own. After a rider dismounted, the mount's token was left holding a full copy of the actor's ownership. The permissions were right, but that token no longer followed later changes to the actor's ownership. It now goes back to following the actor. A token that had its own ownership before anyone mounted keeps it.
- Checked against Foundry 14.371. Nothing in that release changes anything the module uses.

Run on Foundry 14.371 with dnd5e 6.1.2 from a GM's and a player's client together, through the module's API and token updates, not the pointer: mounting and dismounting over the socket, moving and steering the mount, seat layouts turning with the mount, and ownership being granted and taken back. Not yet run on a hex grid or on v13.

## 0.6.0

Dragging a rider drags the mount, and steering is fixed on Foundry v14.

- Dragging the rider in the first seat is now a drag of the mount. Everything shown while dragging is the mount's: its preview with the riders still in their seats, its ruler, its route planned for a token of its size, and its cost against its speed. On the drop the mount moves and the riders are carried. Before, the rider was dragged as its own token, half a space from the saddle, and the move was handed to the mount afterwards.
- Dragging the mount itself shows its riders on the preview too.
- Steering follows the route on v14. The pilot's route was read from the wrong part of the movement, so the mount was sent straight to the destination and every turn was lost.
- A steered mount lands on the grid. It was left half a space off when the pilot's seat sat between spaces.
- A steered mount plans its own route to where the pilot was heading, as a drag of the mount would. A route found for a rider one space across could run a mount two spaces across into a wall corner.
- Riders arrive facing as their mount does. With Token Auto-Rotate on, a rider off the mount's middle swung round with it and ended a few degrees out.
- A mount turned by hand turns its riders, and seats them for the new facing.
- D&D 5e: a mount and its riders are no longer in each other's way. The system's movement automation stopped a rider short of a mount of another disposition, stopped the mount leaving the space its rider was in, and charged each for difficult terrain.
- The API gains `getSeat`, `isPilot`, `ridesTogether` and `isHostile`.

Run on Foundry v14 with dnd5e 6.1.1, as GM, on a square grid. Not yet run from a player's client, on a hex grid, or on v13.

Works with Scorpious187's Token Movement 0.1.1: the range shown while dragging a rider is the mount's.

## Earlier versions

See the [release history](https://github.com/nscarpinatodev/scorpious187s-token-mounting/releases) on GitHub.
