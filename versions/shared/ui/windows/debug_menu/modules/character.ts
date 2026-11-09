import { runInAction } from 'mobx';
import {
  registerDebugModule,
  type DebugAction,
  type DebugRow,
} from '@/modules/gm/debugMenu';
import { CharacterClassNumber, getBaseClass } from '@/core/types';
import { InventoryConstants } from '@/core/inventoryConstants';
import { Hero } from '@/modules/hero';
import { skills, HeroSkills } from '@/modules/skills';
import { isHotbarSkill } from '@/modules/skills/skillCasting';
import { skillDefinition } from '@versions/shared/skills/skillsDatabase';
import { ItemsDatabase, itemBaseName } from '@versions/shared/items/itemsDatabase';
import type { ItemRecord } from '@/controllers/items';
import { classCanUse, classOf, itemDef } from '@/controllers/item_rules';
import { classWorldScale } from '@/controllers/actors/characterScale';
import { isFemaleClass } from '@/controllers/actors/mapPlayerNetClassToModelClass';
import { Ecs } from '@/ecs/current';
import { addNpcToScope } from '@/modules/scope/objects';
import type { Entity } from '@/ecs/world';

/**
 * Character: the offline demo's own test bench. Three things a trial build
 * cannot otherwise reach, each through a seam that already exists:
 *
 *   - the class the hero plays (`?class=` sets it once at boot; this changes
 *     it live, the same writes `evolveHero` makes),
 *   - the gear on every slot and how strongly it is reinforced (everything
 *     goes through `Hero.syncPlayerAppearance`, the one writer the inventory
 *     and the packet handlers use; the renderer's own `itemVisualTier` still
 *     decides what a +level looks like),
 *   - a skill cast (`world.castRequest`, the exact seam the right mouse button
 *     and the mobile pad write; `SkillCastSystem` still owns range, the walk
 *     into it, mana, the delay and the clip).
 *
 * Every item list is filtered out of `ItemsDatabase` at read time and by the
 * hero's own class flags, so the rows can never name an item this build does
 * not carry, and never offer a piece the class cannot wear.
 */

// ---- what a class may wear --------------------------------------------------

/**
 * The engine's own `RequireClass` verdict (`itemStats.classCanUse`, the same
 * one the tooltip and the equip check use), so the pickers can never offer a
 * piece the hero's class cannot wear. An item whose group has no row at all
 * (`itemDef` null) is treated as open, which is what an unmapped group such as
 * the wings' 12 asks for.
 */
function classMayWear(group: number, index: number): boolean {
  const def = itemDef(group, index);
  return !def || classCanUse(def, Hero.heroStats());
}

// ---- class ------------------------------------------------------------------

/**
 * The classes the demo can wear. Each has its five `*Class<nn>.glb` default
 * parts in the shipped asset set, so a switch never leaves a bare model.
 */
const CLASSES: readonly CharacterClassNumber[] = [
  CharacterClassNumber.DarkWizard,
  CharacterClassNumber.SoulMaster,
  CharacterClassNumber.GrandMaster,
  CharacterClassNumber.DarkKnight,
  CharacterClassNumber.BladeKnight,
  CharacterClassNumber.BladeMaster,
  CharacterClassNumber.FairyElf,
  CharacterClassNumber.MuseElf,
  CharacterClassNumber.HighElf,
  CharacterClassNumber.MagicGladiator,
  CharacterClassNumber.DuelMaster,
  CharacterClassNumber.DarkLord,
  CharacterClassNumber.LordEmperor,
  CharacterClassNumber.Summoner,
  CharacterClassNumber.BloodySummoner,
  CharacterClassNumber.DimensionMaster,
  CharacterClassNumber.RageFighter,
  CharacterClassNumber.FistMaster,
];

const classLabel = (cls: CharacterClassNumber): string => CharacterClassNumber[cls] ?? String(cls);

function setClass(cls: CharacterClassNumber): void {
  if (Hero.charClass === cls) return;

  runInAction(() => {
    Hero.charClass = cls;
  });

  const hero = Ecs.world?.playerEntity;
  if (!hero?.charAppearance) return;

  hero.charAppearance.charClass = cls;
  // The body scale is the class's own (ZzzCharacter.cpp:11925-11933), and the
  // armour parts pick a per-class model, so both are re-applied.
  if (hero.transform) hero.transform.scale = classWorldScale(cls);
  if (hero.attributeSystem) {
    hero.attributeSystem.setValue('isFemale', isFemaleClass(cls) ? 1 : 0);
    hero.attributeSystem.setValue('playerNetClass', cls);
  }
  hero.charAppearance.changed = true;
}

// ---- gear -------------------------------------------------------------------

const ARMOR_SLOTS: readonly { slot: number; group: number; name: string }[] = [
  { slot: InventoryConstants.HelmSlot, group: 7, name: 'Helm' },
  { slot: InventoryConstants.ArmorSlot, group: 8, name: 'Armor' },
  { slot: InventoryConstants.PantsSlot, group: 9, name: 'Pants' },
  { slot: InventoryConstants.GlovesSlot, group: 10, name: 'Gloves' },
  { slot: InventoryConstants.BootsSlot, group: 11, name: 'Boots' },
];

const WEAPON_GROUPS = [0, 1, 2, 3, 4, 5, 6];

/** Every item of one group the hero's class may wear, in (index) order. */
function itemsFor(group: number, slot?: number): ItemRecord[] {
  return ItemsDatabase.all()
    .filter(def => {
      if (def.Group !== group) return false;
      // `ItemSlot` is the inventory slot the item belongs in - the same
      // numbers `InventoryConstants` uses. It is what keeps the wings' gift
      // boxes out of the wing list and the arrows out of the sword list.
      if (slot !== undefined && itemDef(group, def.Index)?.slot !== slot) return false;
      return classMayWear(def.Group, def.Index);
    })
    .sort((a, b) => a.Index - b.Index);
}

/**
 * The set numbers that exist in all five armour groups, are worn in the slot
 * each group belongs to, and the hero's class may wear. Filtering by the slot
 * is what keeps the cloaks and the summoner books, which share the armour
 * indexes, out of the sets.
 */
function completeSetIndexes(): number[] {
  const perSlot = ARMOR_SLOTS.map(({ group, slot }) =>
    new Set(itemsFor(group, slot).map(def => def.Index))
  );
  return [...perSlot[1]].filter(i => perSlot.every(set => set.has(i))).sort((a, b) => a - b);
}

function equip(slot: number, def: { group: number; num: number }): void {
  runInAction(() => {
    const held = Hero.items[slot];
    Hero.items[slot] = {
      group: def.group,
      num: def.num,
      lvl: held?.lvl ?? 9,
      isExcellent: held?.isExcellent ?? false,
      isAncient: held?.isAncient ?? false,
      luck: held?.luck ?? false,
      socketCount: held?.socketCount,
      sockets: held?.sockets,
      hasSkill: held?.hasSkill,
    };
  });
  Hero.syncPlayerAppearance();
}

function clearSlot(slot: number): void {
  runInAction(() => {
    Hero.items[slot] = null;
  });
  Hero.syncPlayerAppearance();
}

/** Wear a whole set: the same index in the five armour groups. */
function wearSet(num: number): void {
  runInAction(() => {
    for (const { slot, group } of ARMOR_SLOTS) {
      const held = Hero.items[slot];
      Hero.items[slot] = {
        group,
        num,
        lvl: held?.lvl ?? 9,
        isExcellent: held?.isExcellent ?? false,
        isAncient: held?.isAncient ?? false,
        luck: held?.luck ?? false,
        socketCount: held?.socketCount,
        sockets: held?.sockets,
      };
    }
  });
  Hero.syncPlayerAppearance();
}

function clearArmor(): void {
  runInAction(() => {
    for (const { slot } of ARMOR_SLOTS) Hero.items[slot] = null;
  });
  Hero.syncPlayerAppearance();
}

// ---- reinforcement ----------------------------------------------------------

type Enhance = {
  lvl: number;
  excellent: boolean;
  luck: boolean;
  ancient: boolean;
  sockets: number;
};

/** The chips, in the order the original's item level reads at a glance. */
const ENHANCE_CHIPS: readonly { name: string; patch: Partial<Enhance> }[] = [
  { name: '+0', patch: { lvl: 0 } },
  { name: '+4', patch: { lvl: 4 } },
  { name: '+7', patch: { lvl: 7 } },
  { name: '+9', patch: { lvl: 9 } },
  { name: '+11', patch: { lvl: 11 } },
  { name: '+13', patch: { lvl: 13 } },
  { name: '+15', patch: { lvl: 15 } },
  { name: 'exc', patch: { excellent: true } },
  { name: 'plain', patch: { excellent: false } },
  { name: 'luck', patch: { luck: true } },
  { name: 'ancient', patch: { ancient: true } },
  { name: 'sock 5', patch: { sockets: 5 } },
  { name: 'sock 0', patch: { sockets: 0 } },
];

const GEAR_SLOTS: readonly number[] = [
  ...ARMOR_SLOTS.map(s => s.slot),
  InventoryConstants.LeftHandSlot,
  InventoryConstants.RightHandSlot,
  InventoryConstants.WingsSlot,
];

function patchSlot(slot: number, patch: Partial<Enhance>): void {
  const item = Hero.items[slot];
  if (!item) return;

  runInAction(() => {
    if (patch.lvl !== undefined) item.lvl = patch.lvl;
    if (patch.excellent !== undefined) item.isExcellent = patch.excellent;
    if (patch.luck !== undefined) item.luck = patch.luck;
    if (patch.ancient !== undefined) item.isAncient = patch.ancient;
    if (patch.sockets !== undefined) {
      item.socketCount = patch.sockets;
      item.sockets = patch.sockets > 0
        ? Array.from({ length: patch.sockets }, (_, i) => i)
        : [];
    }
  });

  Hero.syncPlayerAppearance();
}

function patchAll(patch: Partial<Enhance>): void {
  for (const slot of GEAR_SLOTS) patchSlot(slot, patch);
}

// ---- skills -----------------------------------------------------------------

/**
 * Offline has no server to send a skill list, so the demo's hero knows
 * nothing and no cast can go out. Filling the list from the version's own
 * definitions is what makes the cast buttons below do anything at all.
 */
function learnEverySkill(): void {
  const known = new Set(HeroSkills.skills.map(s => s.number));
  let index = HeroSkills.skills.reduce((max, s) => Math.max(max, s.index), -1);
  const added: { index: number; number: number; level: number }[] = [];

  for (const { num } of allHotbarSkills()) {
    if (known.has(num)) continue;
    index++;
    added.push({ index, number: num, level: 0 });
  }

  if (added.length === 0) return;
  runInAction(() => {
    HeroSkills.setSkillList([...HeroSkills.skills, ...added]);
  });
}

function forgetSkills(): void {
  runInAction(() => {
    HeroSkills.setSkillList([]);
  });
}

/** Every skill number the version defines that can sit on a bar. */
function allHotbarSkills(): readonly { num: number; name: string }[] {
  const out: { num: number; name: string }[] = [];
  for (let num = 0; num <= 999; num++) {
    const def = skillDefinition(num);
    if (!def || !isHotbarSkill(num)) continue;
    out.push({ num, name: def.name });
  }
  return out;
}

/**
 * Cast a skill the way the mobile pad does: select it, then write the one
 * request the right mouse button writes. With nothing picked the point falls
 * back to the hero's own tile, which is what a self-cast or a ground drop
 * wants. The target dummy the tab summons is picked automatically when one
 * stands nearby, so a trial cast always has something to land on.
 */
function nearestDummy(): Entity | null {
  const world = Ecs.world;
  const hero = world?.playerEntity;
  if (!world || !hero?.transform) return null;

  let best: Entity | null = null;
  let bestDist = 12 * 12;

  for (const e of world.netObjsQuery.entities) {
    if (e.npcType === undefined || e.dying || !e.transform) continue;
    const dx = e.transform.pos.x - hero.transform.pos.x;
    const dz = e.transform.pos.z - hero.transform.pos.z;
    const d = dx * dx + dz * dz;
    if (d < bestDist) {
      bestDist = d;
      best = e;
    }
  }

  return best;
}

function castSkill(num: number): void {
  const world = Ecs.world;
  const hero = world?.playerEntity;
  if (!world || !hero || hero.dying) return;

  runInAction(() => {
    HeroSkills.selectSkill(num);
  });

  const target = world.attackTarget ?? nearestDummy();
  const pos = target?.transform?.pos;

  world.castRequest = {
    target,
    point: pos
      ? { x: pos.x, y: pos.z }
      : { x: hero.transform.pos.x, y: hero.transform.pos.z },
    forced: false,
  };
}

/**
 * A safe-zone tile refuses every cast (`if (c->SafeZone) break`,
 * ZzzInterface.cpp:3325), and both worlds the demo ships begin on one - so a
 * trial cast would silently do nothing. The switch clears the hero's
 * `inSafeZone` attribute and the `tileFlag` the usability verdict reads.
 */
let safeZoneOff = false;

function toggleSafeZone(): void {
  safeZoneOff = !safeZoneOff;
  const hero = Ecs.world?.playerEntity;

  if (safeZoneOff) {
    Hero.setTileFlag(0);
    hero?.attributeSystem?.setValue('inSafeZone', 0);
    return;
  }

  // Back to whatever the terrain says; the next frame re-reads it anyway.
  hero?.attributeSystem?.setValue('inSafeZone', Hero.tileFlag & 1 ? 1 : 0);
}

// ---- target dummy -----------------------------------------------------------

const DUMMY_ID_BASE = 31000;

/** Lorencia's monsters: Bull Fighter, Hound, Budge Dragon, Spider. */
const DUMMY_TYPES = [0, 1, 2, 3];

let dummyCount = 0;

/**
 * Put a monster a few tiles from the hero, the way `bench.ts` seeds its
 * scene. An offline world has no server to send scope packets, so this is the
 * only way a cast has something to aim at.
 */
function summonDummy(): void {
  const world = Ecs.world;
  const hero = world?.playerEntity;
  if (!world || !hero?.transform) return;

  const type = DUMMY_TYPES[dummyCount % DUMMY_TYPES.length];
  const angle = (dummyCount * Math.PI) / 4;
  dummyCount++;

  const x = Math.round(hero.transform.pos.x + Math.cos(angle) * 6);
  const y = Math.round(hero.transform.pos.z + Math.sin(angle) * 6);

  addNpcToScope(world, {
    Id: DUMMY_ID_BASE + dummyCount,
    TypeNumber: type,
    CurrentPositionX: x,
    CurrentPositionY: y,
    TargetPositionX: x,
    TargetPositionY: y,
    Rotation: 0,
  });
}

// ---- rows -------------------------------------------------------------------

const chip = (
  id: string,
  label: string,
  onClick: () => void,
  active?: () => boolean
): DebugAction => ({ id, label, onClick, active });

function classRow(): DebugRow {
  return {
    kind: 'buttons',
    id: 'class',
    items: CLASSES.map(cls =>
      chip(`class-${cls}`, classLabel(cls), () => setClass(cls), () => Hero.charClass === cls)
    ),
  };
}

function setRow(): DebugRow {
  return {
    kind: 'list',
    id: 'sets',
    items: () => [
      {
        id: 'set-none',
        label: 'None',
        active: () => Hero.armorSlot === null,
        onClick: clearArmor,
      },
      ...completeSetIndexes().map(i => ({
        id: `set-${i}`,
        label: itemBaseName(8, i) || `Set ${i}`,
        active: () => ARMOR_SLOTS.every(s => Hero.items[s.slot]?.num === i),
        onClick: () => wearSet(i),
      })),
    ],
  };
}

/**
 * One hand's picker. The slot is the one the item declares
 * (`ItemSlot` 0 for the main hand, 1 for the off hand), which is exactly how
 * the game decides whether a sword, a shield or a quiver goes there.
 */
function handRow(slot: number, id: string, label: string): DebugRow {
  const rows = WEAPON_GROUPS.flatMap(group =>
    itemsFor(group, slot).map(def => ({
      group: def.Group,
      num: def.Index,
      name: itemBaseName(def.Group, def.Index) || `${def.Group}:${def.Index}`,
    }))
  );

  return {
    kind: 'list',
    id,
    items: () => [
      {
        id: `${id}-none`,
        label: `— ${label}: none —`,
        active: () => Hero.items[slot] === null,
        onClick: () => clearSlot(slot),
      },
      ...rows.map(w => ({
        id: `${id}-${w.group}-${w.num}`,
        label: w.name,
        active: () => Hero.items[slot]?.group === w.group && Hero.items[slot]?.num === w.num,
        onClick: () => equip(slot, w),
      })),
    ],
  };
}

function wingRow(): DebugRow {
  const rows = itemsFor(12, InventoryConstants.WingsSlot).map(def => ({
    num: def.Index,
    name: itemBaseName(12, def.Index) || `Wing ${def.Index}`,
  }));

  return {
    kind: 'list',
    id: 'wings',
    items: () => [
      {
        id: 'wings-none',
        label: '— Wings: none —',
        active: () => Hero.wingsSlot === null,
        onClick: () => clearSlot(InventoryConstants.WingsSlot),
      },
      ...rows.map(w => ({
        id: `wing-${w.num}`,
        label: w.name,
        active: () => Hero.wingsSlot?.num === w.num,
        onClick: () => equip(InventoryConstants.WingsSlot, { group: 12, num: w.num }),
      })),
    ],
  };
}

function enhanceRow(): DebugRow {
  return {
    kind: 'buttons',
    id: 'enhance-all',
    items: ENHANCE_CHIPS.map(e => chip(`enh-${e.name}`, e.name, () => patchAll(e.patch))),
  };
}

function perSlotEnhanceRows(): DebugRow[] {
  return ARMOR_SLOTS.flatMap(({ slot, name }) => {
    const item = Hero.items[slot];
    if (!item) return [];
    return [
      {
        kind: 'info' as const,
        id: `slot-${slot}`,
        label: name,
        value: () => slotLabel(slot),
      },
      {
        kind: 'buttons' as const,
        id: `slot-enh-${slot}`,
        items: ENHANCE_CHIPS.map(e =>
          chip(`slot-${slot}-${e.name}`, e.name, () => patchSlot(slot, e.patch))
        ),
      },
    ];
  });
}

/** The piece in a slot as `name +lvl marks`, for the readouts. */
function slotLabel(slot: number): string {
  const item = Hero.items[slot];
  if (!item) return '— empty —';
  const name = itemBaseName(item.group, item.num) || `${item.group}:${item.num}`;
  const marks = [
    `+${item.lvl ?? 0}`,
    item.isExcellent ? 'exc' : '',
    item.isAncient ? 'anc' : '',
    item.luck ? 'luck' : '',
    item.socketCount ? `${item.socketCount}s` : '',
  ].filter(Boolean);
  return `${name}  ${marks.join(' ')}`;
}

function skillRows(): DebugRow[] {
  const learned = HeroSkills.skills.filter(s => s.number >= 0 && isHotbarSkill(s.number));

  return [
    {
      kind: 'buttons',
      id: 'skill-actions',
      items: [
        chip('skill-learn', 'Learn all', learnEverySkill),
        chip('skill-forget', 'Forget all', forgetSkills),
        chip('skill-safe', 'Ignore safe zone', toggleSafeZone, () => safeZoneOff),
        chip('skill-dummy', 'Summon target', summonDummy),
      ],
    },
    {
      kind: 'info',
      id: 'skill-state',
      label: 'State',
      value: () => {
        const world = Ecs.world;
        const pos = world?.playerEntity?.transform?.pos;
        const flags = [
          safeZoneOff ? 'safe zone ignored' : 'safe zone on',
          pos ? `tile ${Math.floor(pos.x)},${Math.floor(pos.z)}` : 'no hero',
        ];
        return `${learned.length} known · ${flags.join(' · ')}`;
      },
    },
    ...(learned.length === 0
      ? [
          {
            kind: 'info' as const,
            id: 'skill-empty',
            label: 'Cast',
            value: () => 'press "Learn all" first',
          },
        ]
      : [
          {
            kind: 'list' as const,
            id: 'skill-cast',
            items: () =>
              learned.map(({ number }) => {
                const def = skillDefinition(number);
                const verdict = skills.usability(number);
                const costs = [
                  def?.mana ? `${def.mana} MP` : '',
                  def?.ag ? `${def.ag} AG` : '',
                ].filter(Boolean);
                const blocked = verdict.usable
                  ? ''
                  : `  ⛔ ${verdict.blocks.join('/')}`;
                return {
                  id: `cast-${number}`,
                  label: `${def?.name ?? `Skill ${number}`}${costs.length ? `  (${costs.join(', ')})` : ''}${blocked}`,
                  onClick: () => castSkill(number),
                };
              }),
          },
        ]),
    {
      kind: 'info',
      id: 'skill-selected',
      label: 'Selected',
      value: () => {
        const num = HeroSkills.currentSkill;
        return num < 0 ? '—' : (skillDefinition(num)?.name ?? String(num));
      },
    },
  ];
}

// ---- the module -------------------------------------------------------------

registerDebugModule({
  id: 'character',
  title: 'Character',
  order: 20,
  rows: () => [
    { kind: 'section', id: 'class-sec', label: 'Class' },
    {
      kind: 'info',
      id: 'class-now',
      label: 'Playing',
      value: () => {
        const cls = Hero.charClass;
        const base = getBaseClass(cls);
        return `${classLabel(cls)}   (base ${base}, step ${classOf(cls).step})`;
      },
    },
    classRow(),

    { kind: 'section', id: 'set-sec', label: 'Armour set' },
    setRow(),
    ...ARMOR_SLOTS.map(
      ({ slot, name }): DebugRow => ({
        kind: 'info',
        id: `gear-now-${slot}`,
        label: name,
        value: () => slotLabel(slot),
      })
    ),

    { kind: 'section', id: 'hand-sec', label: 'Weapons' },
    handRow(InventoryConstants.LeftHandSlot, 'hand1', 'right hand'),
    handRow(InventoryConstants.RightHandSlot, 'hand2', 'left hand'),

    { kind: 'section', id: 'wing-sec', label: 'Wings' },
    wingRow(),

    { kind: 'section', id: 'enh-sec', label: 'Reinforcement · all slots' },
    enhanceRow(),

    { kind: 'section', id: 'enh-slot-sec', label: 'Reinforcement · per slot' },
    ...perSlotEnhanceRows(),

    { kind: 'section', id: 'skill-sec', label: 'Skill test' },
    ...skillRows(),
  ],
});
