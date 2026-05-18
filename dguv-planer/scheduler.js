const SLOT_CAPACITY = 75;
const SLOTS_PER_DAY = 4;
const DAY_CAPACITY = 300;

const SLOT_TIMES = [
  '08:30 – 10:00',
  '10:00 – 11:30',
  '11:30 – 13:00',
  '13:00 – 14:30'
];

const SLOT_SHORT = ['08:30', '10:00', '11:30', '13:00'];

function slotsNeeded(deviceCount) {
  return Math.ceil(deviceCount / SLOT_CAPACITY);
}

async function runAutoSchedule(db) {
  const objects = await db.all(`
    SELECT o.*, g.name AS group_name
    FROM objects o
    LEFT JOIN groups g ON o.group_id = g.id
    ORDER BY o.device_count DESC
  `);

  const availabilities = await db.all(`
    SELECT a.* FROM availabilities a ORDER BY a.date, a.slot_index
  `);

  const availsByObject = {};
  for (const av of availabilities) {
    if (!availsByObject[av.object_id]) availsByObject[av.object_id] = [];
    availsByObject[av.object_id].push(av);
  }

  // remaining capacity per slot key "date_slot"
  const slotRemaining = {};
  const getRemaining = (date, slot) => {
    const k = `${date}_${slot}`;
    if (slotRemaining[k] === undefined) slotRemaining[k] = SLOT_CAPACITY;
    return slotRemaining[k];
  };
  const useSlot = (date, slot, devices) => {
    const k = `${date}_${slot}`;
    if (slotRemaining[k] === undefined) slotRemaining[k] = SLOT_CAPACITY;
    slotRemaining[k] -= devices;
  };

  await db.run('DELETE FROM bookings');

  const assigned = [];
  const failed = [];

  for (const obj of objects) {
    const needed = slotsNeeded(obj.device_count);
    const available = (availsByObject[obj.id] || []).filter(
      av => getRemaining(av.date, av.slot_index) > 0
    );

    if (available.length === 0) {
      failed.push({ ...obj, reason: 'Keine Verfügbarkeit angegeben' });
      continue;
    }

    // Group by date
    const byDate = {};
    for (const av of available) {
      if (!byDate[av.date]) byDate[av.date] = [];
      byDate[av.date].push(av);
    }
    for (const d in byDate) byDate[d].sort((a, b) => a.slot_index - b.slot_index);

    let pickedSlots = [];

    // Prefer same day
    for (const date of Object.keys(byDate).sort()) {
      if (pickedSlots.length >= needed) break;
      const daySlots = byDate[date].filter(av => getRemaining(av.date, av.slot_index) > 0);
      if (daySlots.length >= needed) {
        pickedSlots = daySlots.slice(0, needed);
        break;
      }
    }

    // Fallback: spread across days
    if (pickedSlots.length < needed) {
      pickedSlots = [];
      const sorted = available.sort((a, b) => {
        if (a.date !== b.date) return a.date.localeCompare(b.date);
        return a.slot_index - b.slot_index;
      });
      for (const av of sorted) {
        if (pickedSlots.length >= needed) break;
        pickedSlots.push(av);
      }
    }

    if (pickedSlots.length < needed) {
      failed.push({ ...obj, reason: `Nur ${pickedSlots.length}/${needed} Fenster verfügbar` });
      continue;
    }

    let devicesLeft = obj.device_count;
    for (const slot of pickedSlots) {
      const devicesInSlot = Math.min(devicesLeft, SLOT_CAPACITY);
      devicesLeft -= devicesInSlot;
      useSlot(slot.date, slot.slot_index, devicesInSlot);
      await db.run(
        'INSERT OR REPLACE INTO bookings (object_id, date, slot_index, devices_in_slot) VALUES (?,?,?,?)',
        [obj.id, slot.date, slot.slot_index, devicesInSlot]
      );
    }

    assigned.push(obj.name);
  }

  return { assigned, failed };
}

module.exports = { runAutoSchedule, SLOT_CAPACITY, SLOTS_PER_DAY, DAY_CAPACITY, SLOT_TIMES, SLOT_SHORT, slotsNeeded };
