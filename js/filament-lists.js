// Every per-filament setting in a saved project gets one value per filament.
//
// The engine keeps OrcaSlicer's built-in default (a single value) for any
// filament setting the chosen filament profiles don't mention. Desktop
// OrcaSlicer always stores one value per filament, and looks up filament 2, 3,
// 4... in these lists when it opens a project: a one-value list makes it run
// past the end and crash ("Assertion '__n < this->size()' failed"). So before
// a project or sliced package leaves the site, each such list is filled out by
// repeating its value, which is what desktop OrcaSlicer does for filaments that
// share a setting.

import { makeZip, readZip } from './zip.js';

const CONFIG = 'Metadata/project_settings.config';

// OrcaSlicer 2.4.2's per-filament settings (Preset.cpp, s_Preset_filament_options),
// used when settings-schema.json doesn't carry the list for the engine's version.
export const FALLBACK_FILAMENT_KEYS = [
  'default_filament_colour', 'required_nozzle_HRC', 'filament_diameter', 'pellet_flow_coefficient',
  'volumetric_speed_coefficients', 'filament_type', 'filament_soluble', 'filament_is_support', 'filament_printable',
  'filament_max_volumetric_speed', 'filament_adaptive_volumetric_speed', 'filament_flow_ratio', 'filament_density',
  'filament_adhesiveness_category', 'filament_cost', 'filament_minimal_purge_on_wipe_tower',
  'filament_tower_interface_pre_extrusion_dist', 'filament_tower_interface_pre_extrusion_length',
  'filament_tower_ironing_area', 'filament_tower_interface_purge_volume', 'filament_tower_interface_print_temp',
  'nozzle_temperature', 'nozzle_temperature_initial_layer', 'cool_plate_temp', 'textured_cool_plate_temp',
  'eng_plate_temp', 'hot_plate_temp', 'textured_plate_temp', 'cool_plate_temp_initial_layer',
  'textured_cool_plate_temp_initial_layer', 'eng_plate_temp_initial_layer', 'hot_plate_temp_initial_layer',
  'textured_plate_temp_initial_layer', 'supertack_plate_temp_initial_layer', 'supertack_plate_temp',
  'temperature_vitrification', 'reduce_fan_stop_start_freq', 'dont_slow_down_outer_wall',
  'slow_down_for_layer_cooling', 'fan_min_speed', 'fan_max_speed', 'enable_overhang_bridge_fan',
  'overhang_fan_speed', 'overhang_fan_threshold', 'close_fan_the_first_x_layers',
  'close_additional_fan_first_x_layers', 'first_x_layer_fan_speed', 'full_fan_speed_layer',
  'additional_fan_full_speed_layer', 'fan_cooling_layer_time', 'slow_down_layer_time', 'slow_down_min_speed',
  'filament_start_gcode', 'filament_end_gcode', 'filament_change_extrusion_role_gcode', 'activate_air_filtration',
  'activate_air_filtration_during_print', 'activate_air_filtration_on_completion', 'during_print_exhaust_fan_speed',
  'complete_print_exhaust_fan_speed', 'filament_retraction_length', 'filament_z_hop', 'filament_z_hop_types',
  'filament_retract_lift_above', 'filament_retract_lift_below', 'filament_retract_lift_enforce',
  'filament_retraction_speed', 'filament_deretraction_speed', 'filament_retract_restart_extra',
  'filament_retraction_minimum_travel', 'filament_retract_when_changing_layer', 'filament_wipe',
  'filament_retract_before_wipe', 'filament_vendor', 'filament_wipe_distance', 'additional_cooling_fan_speed',
  'nozzle_temperature_range_low', 'nozzle_temperature_range_high', 'filament_extruder_variant',
  'enable_pressure_advance', 'pressure_advance', 'adaptive_pressure_advance', 'adaptive_pressure_advance_model',
  'adaptive_pressure_advance_overhangs', 'adaptive_pressure_advance_bridges', 'chamber_temperature',
  'filament_shrink', 'filament_shrinkage_compensation_z', 'support_material_interface_fan_speed',
  'internal_bridge_fan_speed', 'filament_notes', 'ironing_fan_speed', 'filament_ironing_flow',
  'filament_ironing_spacing', 'filament_ironing_inset', 'filament_ironing_speed', 'filament_loading_speed',
  'filament_loading_speed_start', 'filament_unloading_speed', 'filament_unloading_speed_start',
  'filament_toolchange_delay', 'filament_cooling_moves', 'filament_stamping_loading_speed',
  'filament_stamping_distance', 'filament_cooling_initial_speed', 'filament_cooling_final_speed',
  'filament_ramming_parameters', 'filament_multitool_ramming', 'filament_multitool_ramming_volume',
  'filament_multitool_ramming_flow', 'activate_chamber_temp_control', 'chamber_minimal_temperature',
  'filament_long_retractions_when_cut', 'filament_retraction_distances_when_cut', 'idle_temperature',
  'filament_change_length', 'filament_flush_volumetric_speed', 'filament_flush_temp',
  'filament_cooling_before_tower', 'long_retractions_when_ec', 'retraction_distances_when_ec'
];

/**
 * Fill out the per-filament lists of one project_settings.config object.
 * Returns the names of the settings that were filled out.
 */
export function fillFilamentLists(config, keys = FALLBACK_FILAMENT_KEYS) {
  const count = [config.filament_colour, config.filament_settings_id]
    .map((v) => (Array.isArray(v) ? v.length : 0))
    .reduce((a, b) => Math.max(a, b), 0);
  if (count < 2) return [];
  // A filament with several nozzle variants has one entry per variant here.
  const variants = Array.isArray(config.filament_self_index) ? config.filament_self_index.length : 0;
  const filled = [];
  for (const key of keys) {
    const value = config[key];
    if (!Array.isArray(value) || value.length !== 1) continue;
    const length = key === 'filament_extruder_variant' ? Math.max(count, variants) : count;
    if (length < 2) continue;
    config[key] = Array(length).fill(value[0]);
    filled.push(key);
  }
  return filled;
}

/**
 * A 3MF (project or sliced package) with every per-filament list filled out.
 * Returns the same bytes when nothing needed filling, or when the file can't
 * be read (it is then saved as the engine wrote it).
 */
export async function completeFilamentLists(bytes, keys) {
  const list = Array.isArray(keys) && keys.length ? keys : FALLBACK_FILAMENT_KEYS;
  try {
    const files = await readZip(bytes);
    const entry = files.find((f) => f.name === CONFIG);
    if (!entry) return bytes;
    const config = JSON.parse(new TextDecoder().decode(entry.data));
    if (!fillFilamentLists(config, list).length) return bytes;
    entry.data = new TextEncoder().encode(JSON.stringify(config, null, 4));
    return makeZip(files);
  } catch (error) {
    console.warn('filament lists', error);
    return bytes;
  }
}
