// ============================================================
//  FRAKTAL-AKUSTIK-KACHEL   250 × 250 × 60 mm
//  Schallabsorption + Diffusion durch BSP-Fraktalstruktur
//
//  Material:  PLA / PETG
//  Infill:    12–15 % Gyroid
//  Schicht:   0.2 mm empfohlen
//
//  Rendern:   F6 in OpenSCAD (dauert ~30–90 s bei depth=6)
//  Export:    Datei → Als STL exportieren
// ============================================================

// ─── Parameter ───────────────────────────────────────────────

tile_size  = 250;  // mm  Kantenlänge (quadratisch)
base_thick =   3;  // mm  Rückwandstärke (zum Aufkleben/Aufhängen)
h_max      =  57;  // mm  Maximale Säulenhöhe über Rückwand  → Gesamt: 60 mm
h_min      =   5;  // mm  Minimale Säulenhöhe
gap        = 0.8;  // mm  Schlitz zwischen Zellen (Schallschlitze; 0 = kein Spalt)
max_depth  =   6;  // BSP-Rekursionstiefe  (5 = schnell, 7 = fein)
min_cell   =  18;  // mm  Kleinste erlaubte Zellgröße

// ─── Deterministisch-zufällige Hilfsfunktionen ───────────────
//     rands(min, max, count, seed) → gleicher seed = gleiche Form

// Höhe der Blattzelle
function leaf_h(id) =
    h_min + rands(0, 1, 1, id)[0] * (h_max - h_min);

// Splitverhältnis: 33 % – 67 %  (verhindert extrem schmale Zellen)
function split_r(id) =
    0.33 + rands(0, 1, 1, id + 100000)[0] * 0.34;

// Splitrichtung bei ausgeglichenem Seitenverhältnis (0 = X, 1 = Y)
function split_d(id) =
    rands(0, 1, 1, id + 200000)[0] > 0.5 ? 0 : 1;

// ─── Rekursives BSP-Modul ────────────────────────────────────

module bsp(x, y, w, h, lvl, id) {
    ok_x = (w >= min_cell * 2 + gap);
    ok_y = (h >= min_cell * 2 + gap);

    if (lvl >= max_depth || (!ok_x && !ok_y)) {
        // Blattzelle → Quader mit pseudo-zufälliger Höhe
        translate([x + gap/2, y + gap/2, base_thick])
            cube([w - gap, h - gap, leaf_h(id)]);

    } else {
        // Splitrichtung: Seitenverhältnis hat Vorrang, sonst zufällig
        dir = (!ok_y)       ? 0 :          // nur X-Split möglich
              (!ok_x)       ? 1 :          // nur Y-Split möglich
              (w > h * 1.5) ? 0 :          // deutlich breiter → X teilen
              (h > w * 1.5) ? 1 :          // deutlich höher   → Y teilen
              split_d(id);                 // ähnlich → zufällig

        if (dir == 0) {
            sw = w * split_r(id);
            bsp(x,    y, sw,   h, lvl + 1, id * 2    );
            bsp(x+sw, y, w-sw, h, lvl + 1, id * 2 + 1);
        } else {
            sh = h * split_r(id);
            bsp(x, y,    w, sh,   lvl + 1, id * 2    );
            bsp(x, y+sh, w, h-sh, lvl + 1, id * 2 + 1);
        }
    }
}

// ─── Hauptobjekt ─────────────────────────────────────────────

union() {
    // Flache Rückwand
    cube([tile_size, tile_size, base_thick]);

    // Fraktales Diffusor-Muster (BSP, 6 Ebenen)
    bsp(0, 0, tile_size, tile_size, 0, 1);
}
