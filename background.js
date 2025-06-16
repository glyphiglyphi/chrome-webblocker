// In-memory cache for settings and state
let settings = {
  blockedDomains: [],
  dailyQuotaMinutes: 20,
  hourlyUsageCapMinutes: 5,
  currentDayUsedMinutes: 0,
  currentHourUsedMinutes: 0,
  lastDailyReset: new Date().getTime(),
  lastHourlyReset: new Date().getTime(),
  extensionEnabled: true
};

// Function to load all settings from storage into the in-memory cache
function loadSettingsFromStorage() {
  chrome.storage.local.get(null, (loadedSettings) => { // Get all keys
    if (chrome.runtime.lastError) {
      console.error("Error loading settings:", chrome.runtime.lastError);
      return;
    }
    // Merge loaded settings with defaults to ensure all keys are present
    settings = { ...settings, ...loadedSettings };
    console.log('Settings loaded into memory:', settings);
  });
}

// Load settings when the extension starts (not just installed)
// This initial call helps if the extension was already enabled and browser restarts
loadSettingsFromStorage();

// Listen for changes in storage and update the in-memory cache
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'local') {
    for (let key in changes) {
      settings[key] = changes[key].newValue;
    }
    console.log('In-memory settings updated due to storage change:', settings);
  }
});

// Listener for web requests
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.type !== 'main_frame' || !details.url) {
      return { cancel: false }; // Only act on main frame navigations
    }

    if (!settings.extensionEnabled) {
      return { cancel: false }; // Don't block if extension is disabled
    }

    const url = new URL(details.url);
    const domain = url.hostname;

    if (settings.blockedDomains && settings.blockedDomains.includes(domain)) {
      console.log(`Checking domain: ${domain}`);
      // Quota checks (using in-memory 'settings' for synchronous decision)
      const now = new Date().getTime();

      // Quota reset is handled by alarms. Values in 'settings' should be current.
      const dailyQuotaAvailable = settings.currentDayUsedMinutes < settings.dailyQuotaMinutes;
      const hourlyCapAvailable = settings.currentHourUsedMinutes < settings.hourlyUsageCapMinutes;

      if (dailyQuotaAvailable && hourlyCapAvailable) {
        const timeToGrant = settings.hourlyUsageCapMinutes;
        const actualTimeSpentThisSession = Math.min(
          timeToGrant,
          settings.hourlyUsageCapMinutes - settings.currentHourUsedMinutes,
          settings.dailyQuotaMinutes - settings.currentDayUsedMinutes
        );

        if (actualTimeSpentThisSession > 0) {
          settings.currentHourUsedMinutes += actualTimeSpentThisSession;
          settings.currentDayUsedMinutes += actualTimeSpentThisSession;
          // settings.sessionStartTime = now; // Optional: if tracking session start

          console.log(`Quota available for ${domain}. Granting ${actualTimeSpentThisSession} min. New usage H:${settings.currentHourUsedMinutes}, D:${settings.currentDayUsedMinutes}`);

          chrome.storage.local.set({
            currentHourUsedMinutes: settings.currentHourUsedMinutes,
            currentDayUsedMinutes: settings.currentDayUsedMinutes,
            // sessionStartTime: settings.sessionStartTime
          }, () => {
            if (chrome.runtime.lastError) {
              console.error("Error saving time usage to storage:", chrome.runtime.lastError);
            } else {
              console.log("Time usage updated in storage.");
            }
          });
          return { cancel: false };
        } else {
          console.log(`Quota available but calculated grant is 0 for ${domain}. Blocking.`);
        }
      }

      console.log(`Blocking ${domain}. No quota. Daily used: ${settings.currentDayUsedMinutes}/${settings.dailyQuotaMinutes}, Hourly used: ${settings.currentHourUsedMinutes}/${settings.hourlyUsageCapMinutes}`);

      let blockReason = 'blocked';
      if (!(settings.currentDayUsedMinutes < settings.dailyQuotaMinutes)) {
          blockReason = 'no_quota_daily';
      } else if (!(settings.currentHourUsedMinutes < settings.hourlyUsageCapMinutes)) {
          blockReason = 'no_quota_hourly';
      }

      const redirectUrl = chrome.runtime.getURL(`blocked.html?reason=${blockReason}&domain=${encodeURIComponent(domain)}`);

      // Ensure not to redirect the blocked page itself if it's trying to load resources
      if (details.url.startsWith(chrome.runtime.getURL(''))) {
        return {cancel: false};
      }

      return { redirectUrl: redirectUrl };

    }
    return { cancel: false };
  },
  { urls: ["<all_urls>"], types: ["main_frame"] },
  ["blocking"]
);

// --- Alarm Related Logic ---
const HOURLY_RESET_ALARM_NAME = 'hourlyResetAlarm';
const DAILY_RESET_ALARM_NAME = 'dailyResetAlarm';

function setupAlarms() {
  const now = new Date();

  // Hourly Alarm: Target the start of the next hour
  const minutesUntilNextHour = 60 - now.getMinutes();
  const secondsUntilNextHour = 60 - now.getSeconds(); // For more precision
  let delayInMinutesForHourly = minutesUntilNextHour;
  if (secondsUntilNextHour > 0 && minutesUntilNextHour === 60) { // If exactly on the hour, wait a full hour
     delayInMinutesForHourly = 60;
  } else if (secondsUntilNextHour === 0 && now.getMinutes() === 0) { // If exactly on the hour, schedule for next hour
     delayInMinutesForHourly = 60;
  } else if (secondsUntilNextHour > 0 && minutesUntilNextHour > 0) {
    // If we are at HH:MM:SS, delay should be to (HH+1):00:00
    // delayInMinutesForHourly is already correct (e.g. at 10:45:30, it's 15 min to 11:00)
    // but chrome.alarms.create uses 'delayInMinutes' which rounds down,
    // so using 'when' for more precision is better.
  }


  // More precise way to set the first alarm: calculate 'when'
  const firstHourlyFire = new Date(now);
  firstHourlyFire.setHours(now.getHours() + 1);
  firstHourlyFire.setMinutes(0);
  firstHourlyFire.setSeconds(0);
  firstHourlyFire.setMilliseconds(0);
  if (firstHourlyFire.getTime() <= now.getTime()) { // If current hour is e.g. 10:50, next hour is 11:00. If 10:00, next is 11:00
      // if we are at 10:00:00, it should be 11:00:00.
      // if we are at 10:00:01, it should be 11:00:00
      // if we are at 10:59:59, it should be 11:00:00
      // if Date.now() made it schedule for current hour or past, advance it
      // This case should not happen if logic is: current hour + 1, then 0 minutes, 0 seconds
  }


  chrome.alarms.get(HOURLY_RESET_ALARM_NAME, (existingAlarm) => {
    if (!existingAlarm || existingAlarm.scheduledTime !== firstHourlyFire.getTime() || existingAlarm.periodInMinutes !== 60) {
        chrome.alarms.create(HOURLY_RESET_ALARM_NAME, {
            when: firstHourlyFire.getTime(),
            periodInMinutes: 60
        });
        console.log(`Set up ${HOURLY_RESET_ALARM_NAME}. Next fire: ${new Date(firstHourlyFire.getTime())}, then every 60 min.`);
    } else {
        console.log(`${HOURLY_RESET_ALARM_NAME} already correctly scheduled.`);
    }
  });


  // Daily Alarm: Target next midnight
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);
  const periodDailyMinutes = 24 * 60;

  chrome.alarms.get(DAILY_RESET_ALARM_NAME, (existingAlarm) => {
    if(!existingAlarm || existingAlarm.scheduledTime !== tomorrow.getTime() || existingAlarm.periodInMinutes !== periodDailyMinutes) {
        chrome.alarms.create(DAILY_RESET_ALARM_NAME, {
            when: tomorrow.getTime(),
            periodInMinutes: periodDailyMinutes
        });
        console.log(`Set up ${DAILY_RESET_ALARM_NAME}. Next fire: ${new Date(tomorrow.getTime())}, then every ${periodDailyMinutes} min.`);
    } else {
        console.log(`${DAILY_RESET_ALARM_NAME} already correctly scheduled.`);
    }
  });
}

// Initialize settings on installation or startup, and set up alarms
chrome.runtime.onInstalled.addListener((details) => {
  console.log(`onInstalled event, reason: ${details.reason}`);
  if (details.reason === 'install') {
    const initialSettings = {
      blockedDomains: [],
      dailyQuotaMinutes: 20,
      hourlyUsageCapMinutes: 5,
      currentDayUsedMinutes: 0,
      currentHourUsedMinutes: 0,
      lastDailyReset: new Date().getTime(),
      lastHourlyReset: new Date().getTime(),
      extensionEnabled: true
    };
    chrome.storage.local.set(initialSettings, () => {
      console.log('Default settings initialized.');
      loadSettingsFromStorage(); // Load them into memory
      setupAlarms(); // Then setup alarms
    });
  } else if (details.reason === 'update') {
    loadSettingsFromStorage(); // Load on update
    setupAlarms(); // Re-setup alarms on update
  } else {
    // This case handles other scenarios like browser update restarting the extension
    loadSettingsFromStorage(); // Ensure settings are loaded
    setupAlarms(); // And alarms are active
  }
});

// Setup alarms on extension startup (e.g., when browser starts)
chrome.runtime.onStartup.addListener(() => {
  console.log("Extension startup detected (chrome.runtime.onStartup).");
  loadSettingsFromStorage(); // Ensure settings are fresh
  setupAlarms(); // Setup alarms
});

// Listener for alarms
chrome.alarms.onAlarm.addListener((alarm) => {
  const now = new Date().getTime();
  console.log(`Alarm fired: ${alarm.name} at ${new Date(now)}`);

  if (alarm.name === HOURLY_RESET_ALARM_NAME) {
    console.log('Hourly reset triggered.');
    settings.currentHourUsedMinutes = 0;
    settings.lastHourlyReset = now;
    chrome.storage.local.set({
      currentHourUsedMinutes: 0,
      lastHourlyReset: now
    }, () => {
      console.log('Hourly usage reset in storage and memory.');
    });
  } else if (alarm.name === DAILY_RESET_ALARM_NAME) {
    console.log('Daily reset triggered.');
    settings.currentDayUsedMinutes = 0;
    settings.currentHourUsedMinutes = 0; // Daily reset also resets current hour's usage
    settings.lastDailyReset = now;
    settings.lastHourlyReset = now;
    chrome.storage.local.set({
      currentDayUsedMinutes: 0,
      currentHourUsedMinutes: 0,
      lastDailyReset: now,
      lastHourlyReset: now
    }, () => {
      console.log('Daily and hourly usage reset in storage and memory.');
    });
  }
});

console.log('Background script now includes alarm setup and handling for quota resets.');
