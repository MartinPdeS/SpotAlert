import {PROFILE_KEY, PROFILES_KEY, validateProfile} from "./profile.js";
import {evaluateRule} from "./core.js";
export function createProfileStore(api, mutate) {
  const FOLDER_KEY = "spotalert.profile-folder.v1";
  let profilesLoaded = false;
  async function profileFolder(command, library) {
    if (!api.runtime.sendNativeMessage) throw new Error("Install the local profile helper, then reload SpotAlert.");
    let response;
    try { response = await api.runtime.sendNativeMessage("com.spotalert.profiles", {command, ...(library ? {library} : {})}); }
    catch { throw new Error("Local profile helper unavailable. Install it and reload SpotAlert; your Chrome copy is preserved."); }
    if (!response?.ok) throw new Error(response?.error || "Could not access the local profile folder.");
    return response;
  }
  function refreshSearchProfiles(value, library) {
    for (const search of value.searches || []) {
      const profile = library.profiles.find(item => item.id === search.profileId);
      if (!profile) continue;
      delete search.preferences;
      for (const [id, result] of Object.entries(search.results || {})) {
        const monitor = value.monitors.find(item => item.id === id);
        if (!monitor || !result.matches?.length) continue;
        try { result.matches = evaluateRule(result.matches, monitor.rule, {clientPreferences: profile.details}).matches; }
        catch { result.matches = []; result.at = null; }
      }
    }
  }
  async function saveLibrary(library) {
    if ((await api.storage.local.get(FOLDER_KEY))[FOLDER_KEY]?.enabled) await profileFolder("write", library);
    await api.storage.local.set({[PROFILES_KEY]: library, [PROFILE_KEY]: library.profiles.find(item => item.id === library.activeId).details});
    await mutate(value => {
      refreshSearchProfiles(value, library);
    });
  }
  async function profileLibrary() {
    const saved = await api.storage.local.get([PROFILES_KEY, PROFILE_KEY, FOLDER_KEY]);
    if (!profilesLoaded) {
      // Restore disk profiles after removal/reinstallation, even without a Chrome copy.
      try {
        const disk = await profileFolder("read");
        if (disk.pendingLibrary) {
          // A local import augments both copies; never replace the browser library with a single new applicant.
          const base = saved[PROFILES_KEY] || disk.library || {activeId: 'default', profiles: [{id: 'default', name: 'My profile', details: validateProfile(saved[PROFILE_KEY])}]};
          const entries = new Map([...(disk.library?.profiles || []), ...base.profiles].map(entry => [entry.id, entry]));
          for (const entry of disk.pendingLibrary.profiles) if (!entries.has(entry.id)) entries.set(entry.id, entry);
          if (entries.size > 50) throw new Error('Make room for the pending profile import (50 profiles maximum).');
          const library = {...base, profiles: [...entries.values()]};
          for (const entry of library.profiles) entry.details = validateProfile(entry.details);
          await profileFolder('write', library);
          await api.storage.local.set({[PROFILES_KEY]: library, [PROFILE_KEY]: library.profiles.find(entry => entry.id === library.activeId).details, [FOLDER_KEY]: {enabled: true, path: disk.folder}});
          profilesLoaded = true;
          await mutate(value => refreshSearchProfiles(value, library));
          return library;
        }
        if (disk.library) {
          const library = disk.library;
          for (const entry of library.profiles) entry.details = validateProfile(entry.details);
          await api.storage.local.set({[PROFILES_KEY]: library, [PROFILE_KEY]: library.profiles.find(item => item.id === library.activeId).details, [FOLDER_KEY]: {enabled: true, path: disk.folder}});
          profilesLoaded = true;
          await mutate(value => refreshSearchProfiles(value, library));
          return library;
        }
        const library = saved[PROFILES_KEY] || {activeId: "default", profiles: [{id: "default", name: "My profile", details: validateProfile(saved[PROFILE_KEY])}]};
        await profileFolder("write", library);
        await api.storage.local.set({[PROFILES_KEY]: library, [PROFILE_KEY]: library.profiles.find(item => item.id === library.activeId).details, [FOLDER_KEY]: {enabled: true, path: disk.folder}});
        profilesLoaded = true;
        return library;
      } catch { /* Keep the browser copy usable; folder writes still report errors. */ }
      profilesLoaded = true;
    }
    if (saved[PROFILES_KEY]) return saved[PROFILES_KEY];
    const library = {activeId: "default", profiles: [{id: "default", name: "My profile", details: validateProfile(saved[PROFILE_KEY])}]};
    await api.storage.local.set({[PROFILES_KEY]: library});
    return library;
  }
  return {FOLDER_KEY, profileFolder, refreshSearchProfiles, saveLibrary, profileLibrary};
}
