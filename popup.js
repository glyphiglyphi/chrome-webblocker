document.addEventListener('DOMContentLoaded', () => {
  // Existing elements
  const newDomainInput = document.getElementById('newDomain');
  const addDomainBtn = document.getElementById('addDomainBtn');
  const blockedDomainsList = document.getElementById('blockedDomainsList');

  // New elements for quota and settings
  const extensionEnabledToggle = document.getElementById('extensionEnabledToggle');
  const dailyQuotaInput = document.getElementById('dailyQuotaInput');
  const hourlyCapInput = document.getElementById('hourlyCapInput');
  const saveQuotaSettingsBtn = document.getElementById('saveQuotaSettingsBtn');
  const saveStatus = document.getElementById('saveStatus');

  const dailyUsedDisplay = document.getElementById('dailyUsed');
  const dailyTotalDisplay = document.getElementById('dailyTotal');
  const dailyRemainingDisplay = document.getElementById('dailyRemaining');
  const hourlyUsedDisplay = document.getElementById('hourlyUsed');
  const hourlyTotalCapDisplay = document.getElementById('hourlyTotalCap');
  const hourlyRemainingDisplay = document.getElementById('hourlyRemaining');

  const defaultValues = { // For cases where storage hasn't been set yet
      blockedDomains: [],
      dailyQuotaMinutes: 20,
      hourlyUsageCapMinutes: 5,
      currentDayUsedMinutes: 0,
      currentHourUsedMinutes: 0,
      extensionEnabled: true
  };

  // Load all data from storage and update UI
  function loadAllData() {
    chrome.storage.local.get(null, (result) => { // Get all keys
      const data = { ...defaultValues, ...result }; // Merge with defaults

      // Populate blocked domains list (existing logic)
      const domains = data.blockedDomains || [];
      blockedDomainsList.innerHTML = '';
      domains.forEach((domain, index) => {
        const listItem = document.createElement('li');
        listItem.textContent = domain;
        const removeBtn = document.createElement('button');
        removeBtn.textContent = 'Remove';
        removeBtn.addEventListener('click', () => removeDomain(index));
        listItem.appendChild(removeBtn);
        blockedDomainsList.appendChild(listItem);
      });

      // Populate quota settings inputs
      dailyQuotaInput.value = data.dailyQuotaMinutes;
      hourlyCapInput.value = data.hourlyUsageCapMinutes;

      // Populate quota usage display
      const dailyUsed = data.currentDayUsedMinutes || 0;
      const dailyTotal = data.dailyQuotaMinutes;
      const dailyRemaining = Math.max(0, dailyTotal - dailyUsed);

      dailyUsedDisplay.textContent = dailyUsed;
      dailyTotalDisplay.textContent = dailyTotal;
      dailyRemainingDisplay.textContent = dailyRemaining;

      const hourlyUsed = data.currentHourUsedMinutes || 0;
      const hourlyTotal = data.hourlyUsageCapMinutes;
      const hourlyRemaining = Math.max(0, hourlyTotal - hourlyUsed);

      hourlyUsedDisplay.textContent = hourlyUsed;
      hourlyTotalCapDisplay.textContent = hourlyTotal;
      hourlyRemainingDisplay.textContent = hourlyRemaining;

      // Set enable/disable toggle
      extensionEnabledToggle.checked = data.extensionEnabled;
    });
  }

  // Add a new domain (existing logic, ensure it uses the safe 'data.blockedDomains || []')
  function addDomain() {
    const domain = newDomainInput.value.trim();
    if (domain) {
      chrome.storage.local.get(['blockedDomains'], (result) => {
        const domains = result.blockedDomains || [];
        if (!domains.includes(domain)) {
          domains.push(domain);
          chrome.storage.local.set({ blockedDomains: domains }, () => {
            newDomainInput.value = '';
            loadAllData(); // Refresh entire UI
          });
        } else {
          newDomainInput.value = '';
        }
      });
    }
  }

  // Remove a domain by index (existing logic)
  function removeDomain(index) {
    chrome.storage.local.get(['blockedDomains'], (result) => {
      const domains = result.blockedDomains || [];
      if (index >= 0 && index < domains.length) {
        domains.splice(index, 1);
        chrome.storage.local.set({ blockedDomains: domains }, loadAllData);
      }
    });
  }

  // Save Quota Settings
  saveQuotaSettingsBtn.addEventListener('click', () => {
    const newDailyQuota = parseInt(dailyQuotaInput.value, 10);
    const newHourlyCap = parseInt(hourlyCapInput.value, 10);

    if (isNaN(newDailyQuota) || newDailyQuota < 0 || isNaN(newHourlyCap) || newHourlyCap < 0) {
      saveStatus.textContent = 'Invalid input. Please use positive numbers.';
      setTimeout(() => saveStatus.textContent = '', 3000);
      return;
    }
    // Additional validation: hourly cap should not exceed daily quota
    if (newHourlyCap > newDailyQuota) {
        saveStatus.textContent = 'Hourly cap cannot exceed daily quota.';
        setTimeout(() => saveStatus.textContent = '', 3000);
        return;
    }

    chrome.storage.local.set({
      dailyQuotaMinutes: newDailyQuota,
      hourlyUsageCapMinutes: newHourlyCap
    }, () => {
      saveStatus.textContent = 'Settings saved!';
      setTimeout(() => saveStatus.textContent = '', 2000);
      loadAllData(); // Refresh UI to reflect new settings
    });
  });

  // Handle Enable/Disable Toggle
  extensionEnabledToggle.addEventListener('change', () => {
    chrome.storage.local.set({ extensionEnabled: extensionEnabledToggle.checked }, () => {
      loadAllData(); // Optional: refresh UI or just let background handle it
      console.log("Extension enabled state changed to: " + extensionEnabledToggle.checked);
    });
  });

  // Event listeners for domain management (existing)
  addDomainBtn.addEventListener('click', addDomain);
  newDomainInput.addEventListener('keypress', (event) => {
    if (event.key === 'Enter') addDomain();
  });

  // Initial load of all data
  loadAllData();

  // Listen for storage changes to keep popup updated if open
  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local') {
        console.log("Storage changed, popup refreshing.");
        loadAllData();
    }
  });
});
