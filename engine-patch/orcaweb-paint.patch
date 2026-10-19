--- /root/OrcaWeb/bridge/slicer.cpp
+++ bridge/slicer.cpp
@@ -205,6 +205,18 @@
     std::uint32_t offset = 0;
     std::uint32_t length = 0;
     std::vector<ProjectFaceAttributeInput> face_attributes;
+    // Orca Web Slicer extension "x.orcaweb.paint": OrcaSlicer colour painting
+    // for this mesh, as JSON [[triangle index, "paint_color string"], ...].
+    bool has_orca_paint = false;
+    std::uint32_t paint_offset = 0;
+    std::uint32_t paint_length = 0;
+};
+
+// Orca Web Slicer extension "x.orcaweb.parts": extra model parts of an object,
+// each with its own filament, like a multi-part object in desktop OrcaSlicer.
+struct ProjectObjectPartInput {
+    std::string mesh_id;
+    int extruder_id = 0;
 };
 
 struct ProjectObjectInput {
@@ -212,6 +224,7 @@
     std::string mesh_id;
     std::string label;
     int extruder_id = 0;
+    std::vector<ProjectObjectPartInput> parts;
 };
 
 struct ProjectInstanceInput {
@@ -641,7 +654,7 @@
             error = "project mesh must contain id and format";
             return false;
         }
-        if (!reject_unknown_keys(mesh, {"id", "format", "dataRange", "faceAttributes"}, "project mesh", error))
+        if (!reject_unknown_keys(mesh, {"id", "format", "dataRange", "faceAttributes", "orcaPaint"}, "project mesh", error))
             return false;
         ProjectMeshInput parsed;
         if (!valid_project_id(mesh.at("id"), parsed.id, "mesh.id", error))
@@ -712,6 +725,34 @@
             }
             parsed.has_face_attributes = !parsed.face_attributes.empty();
         }
+        if (mesh.contains("orcaPaint")) {
+            const auto& paint = mesh.at("orcaPaint");
+            if (!paint.is_object()
+                || !reject_unknown_keys(paint, {"dataRange"}, "mesh.orcaPaint", error)
+                || !paint.contains("dataRange") || !paint.at("dataRange").is_object()) {
+                if (error.empty()) error = "mesh.orcaPaint must contain dataRange";
+                return false;
+            }
+            const auto& range = paint.at("dataRange");
+            if (!reject_unknown_keys(range, {"offset", "length"}, "mesh.orcaPaint.dataRange", error)
+                || !range.contains("offset") || !range.contains("length")) {
+                if (error.empty()) error = "mesh.orcaPaint.dataRange must contain offset and length";
+                return false;
+            }
+            if (!project_uint32(range.at("offset"), parsed.paint_offset, "mesh.orcaPaint.dataRange.offset", error)
+                || !project_uint32(range.at("length"), parsed.paint_length, "mesh.orcaPaint.dataRange.length", error))
+                return false;
+            if (parsed.paint_length == 0
+                || static_cast<std::uint64_t>(parsed.paint_offset) + parsed.paint_length > object_blob_len) {
+                error = "mesh.orcaPaint.dataRange is outside object_blob";
+                return false;
+            }
+            if (parsed.format != "stl") {
+                error = "mesh.orcaPaint needs an STL mesh";
+                return false;
+            }
+            parsed.has_orca_paint = true;
+        }
         if (!mesh_ids.insert(parsed.id).second) {
             error = "project manifest contains a duplicate mesh id: " + parsed.id;
             return false;
@@ -751,7 +792,7 @@
             error = "project object must contain id and meshId";
             return false;
         }
-        if (!reject_unknown_keys(object, {"id", "meshId", "label", "extruderId"}, "project object", error))
+        if (!reject_unknown_keys(object, {"id", "meshId", "label", "extruderId", "parts"}, "project object", error))
             return false;
         ProjectObjectInput parsed;
         if (!valid_project_id(object.at("id"), parsed.id, "object.id", error)
@@ -785,6 +826,40 @@
             }
             parsed.extruder_id = static_cast<int>(extruder_id);
         }
+        if (object.contains("parts")) {
+            if (!object.at("parts").is_array() || object.at("parts").size() > 64) {
+                error = "object.parts must be an array of at most 64 parts";
+                return false;
+            }
+            for (const auto& part : object.at("parts")) {
+                if (!part.is_object()
+                    || !reject_unknown_keys(part, {"meshId", "extruderId"}, "project object part", error)
+                    || !part.contains("meshId")) {
+                    if (error.empty()) error = "project object part must contain meshId";
+                    return false;
+                }
+                ProjectObjectPartInput parsed_part;
+                if (!valid_project_id(part.at("meshId"), parsed_part.mesh_id, "object.parts.meshId", error))
+                    return false;
+                if (std::none_of(result.meshes.begin(), result.meshes.end(), [&parsed_part](const auto& mesh) {
+                        return mesh.id == parsed_part.mesh_id;
+                    })) {
+                    error = "project object part refers to an unknown mesh: " + parsed_part.mesh_id;
+                    return false;
+                }
+                if (part.contains("extruderId")) {
+                    std::uint32_t part_extruder = 0;
+                    if (!project_uint32(part.at("extruderId"), part_extruder, "object.parts.extruderId", error))
+                        return false;
+                    if (part_extruder > 64) {
+                        error = "object.parts.extruderId is too large";
+                        return false;
+                    }
+                    parsed_part.extruder_id = static_cast<int>(part_extruder);
+                }
+                parsed.parts.push_back(std::move(parsed_part));
+            }
+        }
         result.objects.push_back(std::move(parsed));
     }
 
@@ -1921,7 +1996,7 @@
     return true;
 }
 
-static bool build_project_export_mesh(
+[[maybe_unused]] static bool build_project_export_mesh(
     OrcSession& session,
     const ProjectManifestInput& manifest,
     Slic3r::TriangleMesh& output,
@@ -2065,6 +2140,135 @@
 // project manifest instead treats its matrix as the source of truth and may
 // shear or a non-zero Z translation. Build the native model directly for the
 // project path so the common API does not inherit the prepare transform limit.
+// ---- Orca Web Slicer extensions: colour painting and multi-part objects ----
+
+// A mesh from binary STL bytes with the triangle order kept exactly. Paint is
+// stored per triangle index, so the usual STL repair (which may drop or
+// reorder triangles) must not run on painted meshes.
+static bool exact_stl_mesh(const std::uint8_t* data, std::size_t length, Slic3r::TriangleMesh& out, std::string& error)
+{
+    if (length < 84) {
+        error = "painted or multi-part mesh must be a binary STL";
+        return false;
+    }
+    std::uint32_t count = 0;
+    std::memcpy(&count, data + 80, 4);
+    if (count == 0 || 84 + static_cast<std::uint64_t>(count) * 50 != length) {
+        error = "painted or multi-part mesh must be a binary STL";
+        return false;
+    }
+    std::vector<stl_vertex> vertices;
+    std::vector<stl_triangle_vertex_indices> indices;
+    vertices.reserve(count);
+    indices.reserve(count);
+    std::map<std::array<float, 3>, int> ids;
+    for (std::uint32_t t = 0; t < count; ++t) {
+        const std::uint8_t* facet = data + 84 + static_cast<std::size_t>(t) * 50 + 12;
+        stl_triangle_vertex_indices triangle;
+        for (int k = 0; k < 3; ++k) {
+            std::array<float, 3> v;
+            std::memcpy(v.data(), facet + k * 12, 12);
+            if (!std::isfinite(v[0]) || !std::isfinite(v[1]) || !std::isfinite(v[2])) {
+                error = "painted or multi-part mesh contains invalid coordinates";
+                return false;
+            }
+            auto it = ids.find(v);
+            int id = 0;
+            if (it == ids.end()) {
+                id = static_cast<int>(vertices.size());
+                ids.emplace(v, id);
+                vertices.emplace_back(v[0], v[1], v[2]);
+            } else {
+                id = it->second;
+            }
+            triangle(k) = id;
+        }
+        indices.push_back(triangle);
+    }
+    out = Slic3r::TriangleMesh(indexed_triangle_set(std::move(indices), std::move(vertices)));
+    return true;
+}
+
+// OrcaSlicer paint strings are read without bounds checks later on, so check
+// that each one is a complete, well-formed TriangleSelector tree first.
+static bool valid_paint_string(const std::string& str)
+{
+    if (str.empty() || str.size() > 200000)
+        return false;
+    std::vector<int> nibbles;
+    nibbles.reserve(str.size());
+    for (auto it = str.crbegin(); it != str.crend(); ++it) {
+        const char c = *it;
+        if (c >= '0' && c <= '9') nibbles.push_back(c - '0');
+        else if (c >= 'A' && c <= 'F') nibbles.push_back(10 + c - 'A');
+        else return false;
+    }
+    std::size_t pos = 0;
+    std::size_t pending = 1;
+    while (pending > 0) {
+        if (pos >= nibbles.size())
+            return false;
+        const int code = nibbles[pos++];
+        --pending;
+        const int sides = code & 0b11;
+        if (sides != 0) {
+            pending += static_cast<std::size_t>(sides) + 1;
+        } else if ((code & 0b1100) == 0b1100) {
+            if (pos >= nibbles.size())
+                return false;
+            if (nibbles[pos++] + 3 > static_cast<int>(Slic3r::EnforcerBlockerType::ExtruderMax))
+                return false;
+        }
+        if (pending > nibbles.size())
+            return false;
+    }
+    return true;
+}
+
+static bool apply_orca_paint(const OrcSession& session, const ProjectMeshInput& mesh,
+                             Slic3r::ModelVolume& volume, std::string& error)
+{
+    if (!mesh.has_orca_paint)
+        return true;
+    const std::uint8_t* bytes = session.project_object_blob.data() + mesh.paint_offset;
+    nlohmann::json list;
+    try {
+        list = nlohmann::json::parse(bytes, bytes + mesh.paint_length);
+    } catch (...) {
+        error = "mesh.orcaPaint data is not valid JSON";
+        return false;
+    }
+    if (!list.is_array()) {
+        error = "mesh.orcaPaint data must be an array of [triangle, paint] pairs";
+        return false;
+    }
+    const int facets = static_cast<int>(volume.mesh().its.indices.size());
+    volume.mmu_segmentation_facets.reset();
+    volume.mmu_segmentation_facets.reserve(static_cast<int>(list.size()));
+    int last = -1;
+    for (const auto& entry : list) {
+        if (!entry.is_array() || entry.size() != 2 || !entry[0].is_number_integer() || !entry[1].is_string()) {
+            error = "mesh.orcaPaint entries must be [triangle index, paint string]";
+            return false;
+        }
+        const int index = entry[0].get<int>();
+        const std::string paint = entry[1].get<std::string>();
+        if (index <= last || index >= facets) {
+            error = "mesh.orcaPaint triangle indices must increase and stay inside the mesh";
+            return false;
+        }
+        if (!valid_paint_string(paint)) {
+            error = "mesh.orcaPaint contains damaged paint data";
+            return false;
+        }
+        volume.mmu_segmentation_facets.set_triangle_from_string(index, paint);
+        last = index;
+    }
+    volume.mmu_segmentation_facets.shrink_to_fit();
+    volume.mmu_segmentation_facets.touch();
+    return true;
+}
+
 static oneslicer_status_t build_project_plate_model(
     OrcSession& session,
     const ProjectManifestInput& manifest,
@@ -2118,7 +2322,12 @@
         }
 
         const std::size_t first_object = model.objects.size();
-        if (!load_staged_stl(path.c_str(), &model, object_input->id.c_str())) {
+        if (mesh_input->has_orca_paint || !object_input->parts.empty()) {
+            Slic3r::TriangleMesh exact;
+            if (!exact_stl_mesh(session.project_object_blob.data() + mesh_input->offset, mesh_input->length, exact, error))
+                return ONESLICER_ERR_INPUT_FORMAT;
+            model.add_object(object_input->id.c_str(), "", std::move(exact));
+        } else if (!load_staged_stl(path.c_str(), &model, object_input->id.c_str())) {
             error = "OrcaSlicer could not load project mesh " + mesh_input->id;
             return ONESLICER_ERR_INPUT_FORMAT;
         }
@@ -2151,6 +2360,33 @@
             native_instance->set_transformation(transformation);
             if (object_input->extruder_id > 0)
                 object->config.set("extruder", object_input->extruder_id);
+            if (!object->volumes.empty() && !apply_orca_paint(session, *mesh_input, *object->volumes.front(), error))
+                return ONESLICER_ERR_VALIDATION;
+            // Extra colour parts, in the same frame as the object's own mesh.
+            for (const auto& part : object_input->parts) {
+                const auto* part_mesh = find_project_mesh(manifest, part.mesh_id);
+                if (!part_mesh || part_mesh->format != "stl" || !part_mesh->has_data_range
+                    || static_cast<std::uint64_t>(part_mesh->offset) + part_mesh->length
+                        > session.project_object_blob.size()) {
+                    error = "project object part needs a host-readable STL mesh: " + part.mesh_id;
+                    return ONESLICER_ERR_VALIDATION;
+                }
+                Slic3r::TriangleMesh part_triangles;
+                if (!exact_stl_mesh(session.project_object_blob.data() + part_mesh->offset, part_mesh->length,
+                                    part_triangles, error))
+                    return ONESLICER_ERR_INPUT_FORMAT;
+                auto* volume = object->add_volume(std::move(part_triangles), Slic3r::ModelVolumeType::MODEL_PART);
+                if (!volume) {
+                    error = "OrcaSlicer could not allocate a project object part";
+                    return ONESLICER_ERR_OUTPUT;
+                }
+                volume->name = (object_input->label.empty() ? object_input->id : object_input->label)
+                    + " part " + std::to_string(object->volumes.size() - 1);
+                if (part.extruder_id > 0)
+                    volume->config.set("extruder", part.extruder_id);
+                if (!apply_orca_paint(session, *part_mesh, *volume, error))
+                    return ONESLICER_ERR_VALIDATION;
+            }
         }
     }
 
@@ -3308,7 +3544,7 @@
   "runtime":{"threadingModel":")") + threading_model + R"(","supportedHosts":["web","worker","node"],"requiresSharedArrayBuffer":)" + requires_sab + R"(,"requiresCrossOriginIsolated":)" + requires_sab + R"(,"cancellationMode":"cooperative"},
   "configuration":{"initFormats":["orca.native-json"],"fullProfileFormats":["project.3mf"],"profileApplyFormats":["orca.profile-json","orca.native-json"]},
   "project":{"meshFormats":["stl"],"faceAttributeSemantics":{"triangle":[],"brepFace":[]},"nativeProjectFormats":["project.3mf"],"preservationPolicies":["require","best-effort","portable"],"sliceArtifactExport":"supported"},
-  "features":{"core.session":"supported","core.configuration":"supported","config.fullProfile":"supported","config.profileApply":"supported","project.manifest":"supported","project.modifierVolumes":"supported","project.modifierVolumes.nativeProject":"supported","project.meshFormat.step":"unsupported","project.preview.stepFaces":"unsupported","project.faceAttributes":"unsupported","project.prepare":"supported","project.slice":"supported","project.slice.multiPlate":"supported","project.slice.assets":"supported","project.export":"supported","project.export.sliceArtifacts":"supported","project.export.preservation":"supported","format.objToStl":"supported","format.stepToStl":"supported","format.threeMfToStl":"supported","runtime.capabilities":"supported","runtime.progress":"supported","runtime.cancellation":"supported","runtime.errors":"supported"}
+  "features":{"core.session":"supported","core.configuration":"supported","config.fullProfile":"supported","config.profileApply":"supported","project.manifest":"supported","project.modifierVolumes":"supported","project.modifierVolumes.nativeProject":"supported","project.meshFormat.step":"unsupported","project.preview.stepFaces":"unsupported","project.faceAttributes":"unsupported","project.prepare":"supported","project.slice":"supported","project.slice.multiPlate":"supported","project.slice.assets":"supported","project.export":"supported","project.export.sliceArtifacts":"supported","project.export.preservation":"supported","format.objToStl":"supported","format.stepToStl":"supported","format.threeMfToStl":"supported","runtime.capabilities":"supported","runtime.progress":"supported","runtime.cancellation":"supported","runtime.errors":"supported","x.orcaweb.paint":"supported","x.orcaweb.parts":"supported","x.orcaweb.projectSave":"supported"}
 })";
     if (json.size() > UINT32_MAX) {
         record_error("capability document is too large");
@@ -3946,6 +4182,34 @@
     return true;
 }
 
+// Orca Web Slicer: saved projects keep the adaptive (variable) layer heights.
+// The slice works them out on Print's copies of the objects
+// (apply_adaptive_layer_height); a project save has no Print, so build one the
+// same way, run the same calculation, and copy each object's profile back by
+// ObjectID (Print's copy keeps the IDs). The 3MF writer then stores it in
+// Metadata/layer_heights_profile.txt, where desktop OrcaSlicer and Bambu
+// Studio read it (it shows in their Variable layer height tool).
+static void store_adaptive_layer_height_profiles(OrcSession& session, Slic3r::Model& model) {
+    if (!session.adaptive_layer_height || model.objects.empty())
+        return;
+    try {
+        Slic3r::Print print;
+        print.apply(model, session.config);
+        apply_adaptive_layer_height(print, session.adaptive_layer_height_quality);
+        for (Slic3r::PrintObject* obj : print.objects_mutable()) {
+            const Slic3r::ModelObject* copy = obj ? obj->model_object() : nullptr;
+            if (!copy)
+                continue;
+            for (auto* target : model.objects) {
+                if (target && target->id() == copy->id())
+                    target->layer_height_profile.set(copy->layer_height_profile.get());
+            }
+        }
+    } catch (const std::exception&) {
+        // Keep the project without the profile rather than fail the save.
+    }
+}
+
 // Writes every manifest plate as a native Orca plate and embeds the current
 // G-code of each sliced plate the way desktop Orca saves a sliced project:
 // Metadata/plate_N.gcode, its .md5, the plate's gcode_file reference and its
@@ -4022,6 +4286,7 @@
         error = "project contains no objects to export";
         return ONESLICER_ERR_EMPTY_INPUT;
     }
+    store_adaptive_layer_height_profiles(session, model);
     if (!manifest.modifier_volumes.empty() && !prepare_native_modifier_model_for_export(model, error))
         return ONESLICER_ERR_VALIDATION;
     return write_project_model_3mf(session, model, out_3mf, out_len, &plate_data_list, &config);
@@ -4170,15 +4435,6 @@
                             {"message", "project plate has no current G-code to embed: " + plate_id},
                         });
                 }
-            } else if (manifest.plate_ids.size() > 1) {
-                if (options.preservation == "require") {
-                    record_error(*session, "OrcaWasm portable project export cannot preserve multiple logical plates");
-                    return ONESLICER_ERR_UNSUPPORTED;
-                }
-                warnings.push_back({
-                    {"code", "logical-plates-flattened"},
-                    {"message", "portable OrcaSlicer 3MF export flattens logical plates into one build"},
-                });
             }
             if (options.preservation == "portable") {
                 warnings.push_back({
@@ -4192,13 +4448,20 @@
             uint8_t* exported_data = nullptr;
             uint32_t exported_len = 0;
             oneslicer_status_t export_status = ONESLICER_OK;
-            if (options.include_slice_artifacts) {
+            // Orca Web Slicer: models always stay separate objects (with their
+            // own filaments, parts and paint) and plates stay plates. The
+            // upstream portable path merged every model into one mesh unless
+            // support modifiers were present, and flattened the plates.
+            if (options.include_slice_artifacts || manifest.plate_ids.size() > 1) {
+                // Native plates (and the current G-code, when asked for).
                 export_status = write_project_slice_artifacts_3mf(
                     *session, manifest, gcode_by_plate, &exported_data, &exported_len, error
                 );
                 if (export_status != ONESLICER_OK && !error.empty())
                     record_error(*session, error);
-            } else if (!manifest.modifier_volumes.empty()) {
+            } else {
+                // One plate: upstream's native-model writer (the one it used
+                // for support modifiers), now for every single-plate project.
                 Slic3r::Model native_model;
                 for (const auto& plate_id : manifest.plate_ids) {
                     export_status = build_project_plate_model(
@@ -4209,45 +4472,19 @@
                         return export_status;
                     }
                 }
-                if (!prepare_native_modifier_model_for_export(native_model, error)) {
+                if (native_model.objects.empty()) {
+                    record_error(*session, "project contains no objects to export");
+                    return ONESLICER_ERR_EMPTY_INPUT;
+                }
+                store_adaptive_layer_height_profiles(*session, native_model);
+                if (!manifest.modifier_volumes.empty()
+                    && !prepare_native_modifier_model_for_export(native_model, error)) {
                     record_error(*session, error);
                     return ONESLICER_ERR_VALIDATION;
                 }
                 export_status = write_project_model_3mf(
                     *session, native_model, &exported_data, &exported_len
                 );
-            } else {
-                Slic3r::TriangleMesh mesh;
-                if (!build_project_export_mesh(*session, manifest, mesh, error)) {
-                    record_error(*session, error);
-                    return ONESLICER_ERR_UNSUPPORTED;
-                }
-                const std::string stl_path = "/tmp/ow-project-export-"
-                    + std::to_string(session->id) + ".stl";
-                TempFileGuard stl_guard(stl_path);
-                if (!Slic3r::store_stl(stl_path.c_str(), &mesh, true)) {
-                    record_error(*session, "OrcaSlicer could not serialize the project export mesh");
-                    return ONESLICER_ERR_OUTPUT;
-                }
-                long stl_size = 0;
-                const char* read_error = nullptr;
-                bool out_of_memory = false;
-                char* stl_data = read_file_to_buffer(
-                    stl_path.c_str(), &stl_size, &read_error, &out_of_memory
-                );
-                if (!stl_data) {
-                    record_error(*session, std::string{"unable to read project export mesh: "}
-                        + (read_error ? read_error : "read failed"));
-                    return out_of_memory ? ONESLICER_ERR_OUTPUT : ONESLICER_ERR_INPUT_IO;
-                }
-                export_status = write_single_mesh_3mf(
-                    reinterpret_cast<oneslicer_session_t>(session),
-                    reinterpret_cast<const uint8_t*>(stl_data),
-                    static_cast<uint32_t>(stl_size),
-                    &exported_data,
-                    &exported_len
-                );
-                std::free(stl_data);
             }
             if (export_status != ONESLICER_OK) {
                 std::free(exported_data);
