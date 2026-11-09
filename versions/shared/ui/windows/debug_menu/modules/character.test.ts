import { beforeAll, describe, expect, it, vi } from 'vitest';

// `modules/session` reads `location` while its module is evaluated, which
// happens before any `beforeAll`; `vi.hoisted` runs ahead of the imports.
vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>;
  g.location ??= {
    href: 'http://localhost/?offline',
    search: '?offline',
    pathname: '/',
    hostname: 'localhost',
    protocol: 'http:',
  };
});

import { Hero } from '@/modules/hero';
import { CharacterClassNumber } from '@/core/types';
import { InventoryConstants } from '@/core/inventoryConstants';
import { itemDef } from '@/controllers/item_rules';
import {
  completeSetIndexes,
  itemsFor,
  wearSet,
  clearArmor,
  equip,
  patchAll,
} from './character';

/**
 * The Character tab's lists are built by filtering `ItemsDatabase` at read
 * time. These tests pin the two properties that make the tab trustworthy:
 * every row names an item this build carries and can actually be worn, and
 * the class filter holds.
 */

const ARMOR: readonly [number, number][] = [
  [7, InventoryConstants.HelmSlot],
  [8, InventoryConstants.ArmorSlot],
  [9, InventoryConstants.PantsSlot],
  [10, InventoryConstants.GlovesSlot],
  [11, InventoryConstants.BootsSlot],
];

beforeAll(() => {
  Hero.name = 'PanelTest';
  Hero.charClass = CharacterClassNumber.DarkKnight;
});

describe('debug Character tab item lists', () => {
  it('offers only items that exist and sit in the slot asked for', () => {
    for (const [group, slot] of ARMOR) {
      const rows = itemsFor(group, slot);
      expect(rows.length, `group ${group} is empty`).toBeGreaterThan(0);
      for (const def of rows) {
        expect(def.Group).toBe(group);
        expect(itemDef(group, def.Index)?.slot, `${group}:${def.Index} slot`).toBe(slot);
      }
    }
  });

  it('keeps the wings list to the wearable wings, not the gift boxes', () => {
    const wings = itemsFor(12, InventoryConstants.WingsSlot);
    expect(wings.length).toBeGreaterThan(0);
    for (const def of wings) {
      expect(itemDef(12, def.Index)?.slot).toBe(InventoryConstants.WingsSlot);
    }
    // The group also carries non-worn rows (boxes, cloths); they must not leak in.
    expect(wings.length).toBeLessThan(itemsFor(12).length);
  });

  it('gives each hand only what goes in that hand', () => {
    const main = [0, 1, 2, 3, 4, 5, 6].flatMap(g => itemsFor(g, InventoryConstants.LeftHandSlot));
    const off = [0, 1, 2, 3, 4, 5, 6].flatMap(g => itemsFor(g, InventoryConstants.RightHandSlot));

    expect(main.length).toBeGreaterThan(0);
    expect(off.length).toBeGreaterThan(0);
    for (const def of main) expect(itemDef(def.Group, def.Index)?.slot).toBe(InventoryConstants.LeftHandSlot);
    for (const def of off) expect(itemDef(def.Group, def.Index)?.slot).toBe(InventoryConstants.RightHandSlot);
  });

  it('finds whole five-piece sets the knight can wear', () => {
    Hero.charClass = CharacterClassNumber.DarkKnight;
    const sets = completeSetIndexes();

    // The five armour slots each need a piece with the same index.
    expect(sets.length).toBeGreaterThan(0);
    for (const i of sets) {
      for (const [group, slot] of ARMOR) {
        const piece = itemsFor(group, slot).find(def => def.Index === i);
        expect(piece, `set ${i} is missing group ${group}`).toBeDefined();
      }
    }
  });

  it('re-filters the sets when the class changes', () => {
    Hero.charClass = CharacterClassNumber.DarkKnight;
    const knight = completeSetIndexes();

    Hero.charClass = CharacterClassNumber.DarkLord;
    const lord = completeSetIndexes();

    // Both classes must get a non-empty list, and the lists must differ: the
    // knight's own sets are not the lord's.
    expect(knight.length).toBeGreaterThan(0);
    expect(lord.length).toBeGreaterThan(0);
    expect(lord).not.toEqual(knight);

    Hero.charClass = CharacterClassNumber.DarkKnight;
  });
});

describe('debug Character tab writes', () => {
  it('wears a whole set and clears it again', () => {
    wearSet(1);
    for (const [, slot] of ARMOR) {
      expect(Hero.items[slot]?.num).toBe(1);
    }

    clearArmor();
    for (const [, slot] of ARMOR) {
      expect(Hero.items[slot]).toBeNull();
    }
  });

  it('reinforces every slot and keeps the socket count consistent', () => {
    wearSet(1);
    equip(InventoryConstants.LeftHandSlot, { group: 0, num: 0 });

    patchAll({ lvl: 15, excellent: true, sockets: 5 });

    expect(Hero.items[InventoryConstants.ArmorSlot]?.lvl).toBe(15);
    expect(Hero.items[InventoryConstants.ArmorSlot]?.isExcellent).toBe(true);
    expect(Hero.items[InventoryConstants.LeftHandSlot]?.socketCount).toBe(5);
    // The socket byte array must match the count, since the renderer reads both.
    expect(Hero.items[InventoryConstants.LeftHandSlot]?.sockets).toHaveLength(5);

    patchAll({ sockets: 0 });
    expect(Hero.items[InventoryConstants.LeftHandSlot]?.sockets).toHaveLength(0);
  });
});
