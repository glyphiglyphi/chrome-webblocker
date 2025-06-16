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

let nextRuleId = 1;
const REBLOCK_ALARM_PREFIX = 'reblock_alarm_';

// Function to load all settings from storage into the in-memory cache
function loadSettingsFromStorage() {
  return new Promise((resolve) => {
    chrome.storage.local.get(null, (loadedSettings) => {
      if (chrome.runtime.lastError) {
        console.error("Error loading settings:", chrome.runtime.lastError);
        resolve();
        return;
      }
      settings = { ...settings, ...loadedSettings };
      console.log('Settings loaded into memory:', settings);
      resolve();
    });
  });
}

// Function to update declarativeNetRequest rules
async function updateDeclarativeNetRequestRules() {
  const newRules = [];
  let currentRuleId = 1;

  // If extension is disabled, remove all our rules and re-block alarms
  if (!settings.extensionEnabled) {
    const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
    const ruleIdsToRemove = existingRules.map(rule => rule.id);

    if (ruleIdsToRemove.length > 0) {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ruleIdsToRemove });
      console.log('Extension disabled, removed all dynamic rules.');
    }

    const allAlarms = await chrome.alarms.getAll();
    for (const alarm of allAlarms) {
        if (alarm.name.startsWith(REBLOCK_ALARM_PREFIX)) {
            await chrome.alarms.clear(alarm.name);
            console.log(`Cleared re-block alarm: ${alarm.name}`);
        }
    }
    return; // Stop further processing if disabled
  }

  // If enabled, proceed to build rules for currently blocked domains
  if (settings.blockedDomains && settings.blockedDomains.length > 0) {
    settings.blockedDomains.forEach(domain => {
      if (domain && typeof domain === 'string' && domain.trim() !== '') {
        const cleanedDomain = domain.trim().replace(/^www\./i, '');
        newRules.push({
          id: currentRuleId++,
          priority: 1,
          action: {
            type: 'redirect',
            redirect: { extensionPath: '/blocked.html?reason=declarative_block&domain=' + encodeURIComponent(cleanedDomain) }
          },
          condition: {
            urlFilter: `||${cleanedDomain}^`,
            resourceTypes: ['main_frame']
          }
        });
      } else {
        console.warn("Skipping invalid domain for DNR rule:", domain);
      }
    });
  }

  try {
    const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
    const ruleIdsToRemove = existingRules.map(rule => rule.id);

    if (ruleIdsToRemove.length > 0 || newRules.length > 0) {
        await chrome.declarativeNetRequest.updateDynamicRules({
            removeRuleIds: ruleIdsToRemove,
            addRules: newRules
        });
        console.log('DNR rules updated. Removed:', ruleIdsToRemove.length, 'Added:', newRules.length, newRules.map(r => r.condition.urlFilter));
    } else {
        console.log('No change to DNR rules needed.');
    }
    nextRuleId = currentRuleId;
  } catch (error) {
    console.error("Error updating DNR rules:", error, error.stack);
    if (error.message.includes("Invalid urlFilter")) {
        console.error("Problematic domains list for DNR:", settings.blockedDomains);
    }
  }
}

// Initialize settings on installation or startup
chrome.runtime.onInstalled.addListener(async (details) => {
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
    await new Promise(resolve => chrome.storage.local.set(initialSettings, resolve));
    console.log('Default settings initialized.');
  }
  await loadSettingsFromStorage();
  await updateDeclarativeNetRequestRules();
  setupAlarms();
});

chrome.runtime.onStartup.addListener(async () => {
  console.log("Extension startup detected.");
  await loadSettingsFromStorage();
  await updateDeclarativeNetRequestRules();
  setupAlarms();
});

chrome.storage.onChanged.addListener(async (changes, namespace) => {
  if (namespace === 'local') {
    let rulesNeedUpdate = false;
    let oldExtensionEnabledState = settings.extensionEnabled;

    for (let key in changes) {
      settings[key] = changes[key].newValue;
      if (key === 'blockedDomains' || key === 'extensionEnabled') {
        rulesNeedUpdate = true;
      }
    }
    console.log('In-memory settings updated:', settings);
    if (rulesNeedUpdate) {
      // If extensionEnabled state changed from true to false, updateDeclarativeNetRequestRules will clear re-block alarms.
      await updateDeclarativeNetRequestRules();
    }
  }
});

// Message listener
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'GET_QUOTA_STATUS') {
    if (!settings.extensionEnabled) {
      sendResponse({ quotaAvailable: false, reason: 'Extension is disabled.' });
      return true;
    }
    const dailyQuotaAvailable = settings.currentDayUsedMinutes < settings.dailyQuotaMinutes;
    const hourlyCapAvailable = settings.currentHourUsedMinutes < settings.hourlyUsageCapMinutes;

    if (dailyQuotaAvailable && hourlyCapAvailable) {
      const timeToGrant = Math.min(
        settings.hourlyUsageCapMinutes - settings.currentHourUsedMinutes,
        settings.dailyQuotaMinutes - settings.currentDayUsedMinutes
      );
      sendResponse({
        quotaAvailable: true,
        timeToGrant: timeToGrant > 0 ? timeToGrant : 0, // Ensure non-negative
        minutesAvailableInHour: settings.hourlyUsageCapMinutes - settings.currentHourUsedMinutes,
        minutesAvailableInDay: settings.dailyQuotaMinutes - settings.currentDayUsedMinutes
      });
    } else {
      let reason = 'No quota available.';
      if (!dailyQuotaAvailable) reason = 'Daily quota exceeded.';
      else if (!hourlyCapAvailable) reason = 'Hourly quota for this hour exceeded.';
      sendResponse({ quotaAvailable: false, reason: reason });
    }
    return true;
  }
  else if (request.type === 'UNLOCK_DOMAIN_REQUEST') {
    const domainToUnlock = request.domain;
    if (!settings.extensionEnabled) {
      sendResponse({ unlocked: false, reason: 'Extension is disabled.' });
      return true;
    }

    const dailyQuotaAvailable = settings.currentDayUsedMinutes < settings.dailyQuotaMinutes;
    const hourlyCapAvailable = settings.currentHourUsedMinutes < settings.hourlyUsageCapMinutes;

    if (domainToUnlock && dailyQuotaAvailable && hourlyCapAvailable) {
      const timeToGrant = Math.min(
        settings.hourlyUsageCapMinutes - settings.currentHourUsedMinutes,
        settings.dailyQuotaMinutes - settings.currentDayUsedMinutes
      );

      if (timeToGrant <= 0) {
        sendResponse({ unlocked: false, reason: 'No time available in current quota slots.' });
        return true;
      }

      (async () => {
        const originalBlockedDomains = [...settings.blockedDomains];
        // Temporarily remove domain from list to update DNR rules
        settings.blockedDomains = settings.blockedDomains.filter(d => d !== domainToUnlock);
        await updateDeclarativeNetRequestRules(); // Update rules to unblock
        settings.blockedDomains = originalBlockedDomains; // Restore for data integrity

        settings.currentHourUsedMinutes += timeToGrant;
        settings.currentDayUsedMinutes += timeToGrant;
        await new Promise(resolve => chrome.storage.local.set({
          currentHourUsedMinutes: settings.currentHourUsedMinutes,
          currentDayUsedMinutes: settings.currentDayUsedMinutes
        }, resolve));

        const alarmName = `${REBLOCK_ALARM_PREFIX}${domainToUnlock}`;
        chrome.alarms.create(alarmName, { delayInMinutes: timeToGrant });
        console.log(`Domain ${domainToUnlock} unlocked for ${timeToGrant} mins. Alarm ${alarmName} set.`);
        sendResponse({ unlocked: true, domain: domainToUnlock, grantedTime: timeToGrant });
      })();

      return true; // Async response
    } else {
      let reason = 'Not enough quota or domain invalid.';
       if (!dailyQuotaAvailable) reason = 'Daily quota exceeded.';
       else if (!hourlyCapAvailable) reason = 'Hourly quota for this hour exceeded.';
      sendResponse({ unlocked: false, reason: reason });
    }
    return true;
  }
  return false; // Default for synchronous messages or if not handled
});


// --- Alarm Related Logic ---
const HOURLY_RESET_ALARM_NAME = 'hourlyResetAlarm';
const DAILY_RESET_ALARM_NAME = 'dailyResetAlarm';

function setupAlarms() {
  const now = new Date();
  const firstHourlyFire = new Date(now);
  firstHourlyFire.setHours(now.getHours() + 1);
  firstHourlyFire.setMinutes(0);
  firstHourlyFire.setSeconds(0);
  firstHourlyFire.setMilliseconds(0);

  chrome.alarms.get(HOURLY_RESET_ALARM_NAME, (existingAlarm) => {
    if (!existingAlarm || existingAlarm.scheduledTime !== firstHourlyFire.getTime() || existingAlarm.periodInMinutes !== 60) {
        chrome.alarms.create(HOURLY_RESET_ALARM_NAME, { when: firstHourlyFire.getTime(), periodInMinutes: 60 });
        console.log(`Set/Updated ${HOURLY_RESET_ALARM_NAME}. Next: ${new Date(firstHourlyFire.getTime())}`);
    }
  });

  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);
  chrome.alarms.get(DAILY_RESET_ALARM_NAME, (existingAlarm) => {
    if(!existingAlarm || existingAlarm.scheduledTime !== tomorrow.getTime() || existingAlarm.periodInMinutes !== (24*60)) {
        chrome.alarms.create(DAILY_RESET_ALARM_NAME, { when: tomorrow.getTime(), periodInMinutes: 24 * 60 });
        console.log(`Set/Updated ${DAILY_RESET_ALARM_NAME}. Next: ${new Date(tomorrow.getTime())}`);
    }
  });
}

chrome.alarms.onAlarm.addListener(async (alarm) => { // Made async for await updateDeclarativeNetRequestRules
  const now = new Date().getTime();
  console.log(`Alarm fired: ${alarm.name} at ${new Date(now)}`);
  let newStorageValues = {};
  let needsStorageUpdate = false;

  if (alarm.name === HOURLY_RESET_ALARM_NAME) {
    settings.currentHourUsedMinutes = 0;
    settings.lastHourlyReset = now;
    newStorageValues.currentHourUsedMinutes = 0;
    newStorageValues.lastHourlyReset = now;
    needsStorageUpdate = true;
  } else if (alarm.name === DAILY_RESET_ALARM_NAME) {
    settings.currentDayUsedMinutes = 0;
    settings.currentHourUsedMinutes = 0;
    settings.lastDailyReset = now;
    settings.lastHourlyReset = now;
    newStorageValues.currentDayUsedMinutes = 0;
    newStorageValues.currentHourUsedMinutes = 0;
    newStorageValues.lastDailyReset = now;
    newStorageValues.lastHourlyReset = now;
    needsStorageUpdate = true;
  } else if (alarm.name.startsWith(REBLOCK_ALARM_PREFIX)) {
    const domainToReblock = alarm.name.substring(REBLOCK_ALARM_PREFIX.length);
    console.log(`Re-block alarm for ${domainToReblock}.`);
    // Ensure domain is in settings.blockedDomains (it should be due to how UNLOCK_DOMAIN_REQUEST works)
    // Then call updateDeclarativeNetRequestRules to re-apply all blocking rules.
    if (settings.extensionEnabled && !settings.blockedDomains.includes(domainToReblock)) {
        // This state should ideally not be reached if logic is sound.
        // However, as a safeguard:
        // settings.blockedDomains.push(domainToReblock);
        // await new Promise(resolve => chrome.storage.local.set({ blockedDomains: settings.blockedDomains }, resolve));
        // console.warn(`Domain ${domainToReblock} was not in memory, added back for re-blocking.`);
    }
    // updateDeclarativeNetRequestRules will use settings.blockedDomains which should include the domain to re-block.
    await updateDeclarativeNetRequestRules();
    console.log(`Domain ${domainToReblock} should now be re-blocked.`);
  }

  if (needsStorageUpdate) {
    await new Promise(resolve => chrome.storage.local.set(newStorageValues, () => {
      if (chrome.runtime.lastError) console.error("Error in alarm storage update:", chrome.runtime.lastError);
      else console.log('Usage reset/updated in storage due to alarm.');
      resolve();
    }));
  }
});

(async () => {
  await loadSettingsFromStorage();
  await updateDeclarativeNetRequestRules();
  setupAlarms();
  console.log('FocusGuard background.js initialized (quota unlock features).');
})();
