const SLOT_CAPACITY = 75;   // max Geräte pro Zeitfenster
const SLOTS_PER_DAY = 4;
const DAY_CAPACITY = 300;   // max Geräte pro Tag

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

function runAutoSchedule(db) {
  // Largest objects first (greedy bin-packing)
  const objects = db.prepare(`
    SELECT o.*, g.name AS group_name
    FROM objects o
    LEFT JOIN groups g ON o.group_id = g.id
    ORDER BY o.device_count DESC
  `).all();

  const availabilities = db.prepare(`
    SELECT a.* FROM availabilities a
    ORDER BY a.date, a.slot_index
  `).all();

  // Group availabilities by object
  const availsByObject = {};
  for (const av of availabilities) {
    if (!availsByObject[av.object_id]) availsByObject[av.object_id] = [];
    availsByObject[av.object_id].push(av);
  }

  // Track remaining capacity per slot: "date_slotIndex" -> devices remaining
  const slotRemaining = {};
  const getRemaining = (date, slot) => {
    const key = `${date}_${slot}`;
    if (slotRemaining[key] === undefined) slotRemaining[key] = SLOT_CAPACITY;
    return slotRemaining[key];
  };
  const useSlot = (date, slot, devices) => {
    const key = `${date}_${slot}`;
    if (slotRemaining[key] === undefined) slotRemaining[key] = SLOT_CAPACITY;
    slotRemaining[key] -= devices;
  };

  db.prepare('DELETE FROM bookings').run();

  const assigned = [];
  const failed = [];

  const insertBooking = db.prepare(
    'INSERT OR REPLACE INTO bookings (object_id, date, slot_index, devices_in_slot) VALUES (?,?,?,?)'
  );

  const scheduleMany = db.transaction(() => {
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

      // Try to find all needed slots on the same day first
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
        insertBooking.run(obj.id, slot.date, slot.slot_index, devicesInSlot);
      }

      assigned.push(obj.name);
    }
  });

  scheduleMany();

  return { assigned, failed };
}

module.exports = { runAutoSchedule, SLOT_CAPACITY, SLOTS_PER_DAY, DAY_CAPACITY, SLOT_TIMES, SLOT_SHORT, slotsNeeded };
