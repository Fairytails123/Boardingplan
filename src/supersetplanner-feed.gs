// ============================================================
// Fairy Tails K9 Centre — Boarding Calendar & Feeding Board API
// Google Apps Script: Fetches boarding data from Acuity Scheduling
// and feeding requirements from JotForm, returns JSON via doGet.
//
// MODES:
//   ?mode=boarding  (default) → Boarding calendar data
//   ?mode=feeding             → Boarding + feeding requirements
//
// TIMEZONE ASSUMPTION:
//   This script uses new Date() which inherits the Apps Script project
//   timezone (set in Project Settings). The frontend display (index.html)
//   also uses new Date() which inherits the browser's timezone.
//   Both MUST be set to the same timezone (Europe/London) for correct
//   date comparisons. If the TV browser is in a different timezone,
//   stays may appear/disappear incorrectly around midnight.
//
// SETUP:
//   Update the credential variables below if keys are rotated.
//   Update API_TOKEN and match it in index.html.
// ============================================================

// --- Acuity API Credentials ---
var ACUITY_USER_ID = '13914499';
var ACUITY_API_KEY = 'e9059c6c60e2e64e5561b25802a366e9';
var ACUITY_BASE_URL = 'https://acuityscheduling.com/api/v1';

// --- JotForm API Credentials ---
var JOTFORM_API_KEY = '03e6dc875fac74cd82ebc8e3c047990c';
var JOTFORM_FORM_ID = '240635310347348';
var JOTFORM_BASE_URL = 'https://eu-api.jotform.com';

// --- API Token for request validation ---
var API_TOKEN = 'ft-k9-board-2024-sec';

// --- Boarding appointment type name (case-insensitive match) ---
var BOARDING_TYPE_NAME = 'dog boarding';

// --- ADDED: Boarding School appointment type name (case-insensitive match) ---
var BOARDING_SCHOOL_TYPE_NAME = 'boarding school';

// --- Cache durations ---
var FEEDING_CACHE_SECONDS = 1800; // 30 minutes for JotForm data
var BOARDING_TYPE_CACHE_SECONDS = 86400; // 24 hours for appointment type ID
var BOARDING_DATA_CACHE_SECONDS = 900; // 15 minutes for the full boarding response

// --- Date range for boarding data ---
// Display window is today + FORWARD_DAYS. LOOKBACK_DAYS only needs to be long
// enough to catch ongoing stays that started before today; 10 days covers the
// vast majority of stays and keeps the appointments-list response small.
var LOOKBACK_DAYS = 10;
var FORWARD_DAYS = 6;

// --- API fetch limits ---
var MAX_APPOINTMENTS = 500;
var JOTFORM_PAGE_LIMIT = 1000;
var CACHE_SIZE_LIMIT = 100000; // CacheService per-key limit in characters

// --- JotForm field IDs for form 240635310347348 ---
// Update these if the JotForm is recreated with different field IDs
var JOTFORM_FIELDS = {
  DOG_NAME: '33',
  OWNER_SURNAME: '59',
  MEALS_PER_DAY: '48',
  FOOD_TYPES: '51',
  KIBBLE_MEASUREMENT: '52',
  KIBBLE_CUP_SIZE: '53',
  KIBBLE_QUANTITY: '43',
  HANDFUL_TIMES: '56',
  SCOOP_QUANTITY: '55',
  WET_FOOD: '49',
  TIN_FOOD: '50',
  SPECIAL_NOTES: '40',
  MEDICATION: '38',
  MEDICATION_DETAILS: '26'
};


// ============================================================
// WEB APP ENTRY POINT
// ============================================================

/**
 * Serves data as JSON when the web app URL is visited.
 * Supports two modes via the 'mode' query parameter:
 *   - 'boarding' (default): Boarding calendar data from Acuity
 *   - 'feeding': Boarding stays + matched JotForm feeding records
 *
 * @param {Object} e - The event parameter from doGet
 */
function doGet(e) {
  // --- Token validation ---
  var expectedToken = API_TOKEN;
  var providedToken = (e && e.parameter && e.parameter.token) ? e.parameter.token : '';

  if (expectedToken && providedToken !== expectedToken) {
    return ContentService
      .createTextOutput(JSON.stringify({ error: 'Forbidden: invalid or missing token' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var mode = (e && e.parameter && e.parameter.mode) ? e.parameter.mode : 'boarding';
  var data;

  if (mode === 'feeding') {
    data = getFeedingBoardData();
  } else {
    data = getBoardingData();
  }

  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}


// ============================================================
// ACUITY API HELPERS (unchanged from original)
// ============================================================

/**
 * Builds the Basic Auth header for Acuity API requests.
 */
function getAcuityAuthHeader_() {
  return 'Basic ' + Utilities.base64Encode(ACUITY_USER_ID + ':' + ACUITY_API_KEY);
}

/**
 * Retries a function up to maxRetries times with a delay between attempts.
 * @param {Function} fn         - Function to execute (should return a value or throw)
 * @param {number}   maxRetries - Number of retry attempts (default 2)
 * @param {number}   delayMs    - Milliseconds between retries (default 2000)
 * @return {*} The return value of fn
 */
function withRetry_(fn, maxRetries, delayMs) {
  maxRetries = maxRetries || 2;
  delayMs = delayMs || 2000;
  var lastError;

  for (var attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return fn();
    } catch (e) {
      lastError = e;
      Logger.log('Attempt ' + (attempt + 1) + ' failed: ' + e.message);
      if (attempt < maxRetries) {
        Utilities.sleep(delayMs);
      }
    }
  }
  throw lastError;
}

/**
 * Makes a GET request to the Acuity API with retry logic.
 * @param {string} endpoint - API path, e.g. '/appointments'
 * @param {Object} params   - Query parameters as key/value pairs
 * @return {Array|Object}   - Parsed JSON response
 */
function acuityGet_(endpoint, params) {
  var url = ACUITY_BASE_URL + endpoint;

  if (params) {
    var qs = Object.keys(params).map(function(key) {
      return encodeURIComponent(key) + '=' + encodeURIComponent(params[key]);
    }).join('&');
    url += '?' + qs;
  }

  var options = {
    method: 'get',
    headers: {
      'Authorization': getAcuityAuthHeader_()
    },
    muteHttpExceptions: true
  };

  return withRetry_(function() {
    var response = UrlFetchApp.fetch(url, options);
    var code = response.getResponseCode();

    if (code !== 200) {
      Logger.log('Acuity API error (' + code + '): ' + response.getContentText());
      throw new Error('Acuity API returned status ' + code);
    }

    try {
      return JSON.parse(response.getContentText());
    } catch (parseErr) {
      Logger.log('Acuity response parse error: ' + parseErr.message);
      throw new Error('Acuity API returned invalid JSON (status ' + code + ')');
    }
  });
}

/**
 * Finds the appointmentTypeID for a given type name.
 * Fetches all types once and caches each result for 24 hours.
 *
 * @param {string} typeName  - Type name to match (case-insensitive), e.g. 'dog boarding'
 * @param {string} cacheKey  - Cache key for this type, e.g. 'boardingTypeId'
 * @return {number|null}
 */
function getAppointmentTypeId_(typeName, cacheKey) {
  var cache = CacheService.getScriptCache();
  var cached = cache.get(cacheKey);
  if (cached) return parseInt(cached, 10);

  // Fetch all types — cache the raw list so a second call for a different type
  // can reuse the same API response within this execution
  var types;
  var cachedTypes = cache.get('allAppointmentTypes');
  if (cachedTypes) {
    try { types = JSON.parse(cachedTypes); } catch (e) { types = null; }
  }
  if (!types) {
    types = acuityGet_('/appointment-types', {});
    try {
      cache.put('allAppointmentTypes', JSON.stringify(types), BOARDING_TYPE_CACHE_SECONDS);
    } catch (e) {
      Logger.log('Could not cache appointment types: ' + e.message);
    }
  }

  var typeId = null;
  for (var i = 0; i < types.length; i++) {
    if (types[i].name && types[i].name.toLowerCase() === typeName) {
      typeId = types[i].id;
      break;
    }
  }

  if (typeId) {
    cache.put(cacheKey, typeId.toString(), BOARDING_TYPE_CACHE_SECONDS);
  }

  return typeId;
}

/** Finds the appointmentTypeID for "Dog Boarding". */
function getBoardingTypeId_() {
  return getAppointmentTypeId_(BOARDING_TYPE_NAME, 'boardingTypeId');
}

/**
 * Reads the persisted dog-name cache from PropertiesService.
 * Stored as a single JSON-encoded { appointmentId: dogName } map.
 *
 * Why PropertiesService instead of CacheService: appointment IDs are stable
 * and dog names for an ID never change, so we want the cache to survive
 * indefinitely. CacheService entries can be evicted at any time and are
 * capped at a 6-hour TTL, which forces unnecessary re-fetches of
 * /appointments/:id (the most expensive Acuity calls in this script).
 *
 * @return {Object} Map of { appointmentId: dogName }
 */
function getDogNameCache_() {
  try {
    var stored = PropertiesService.getScriptProperties().getProperty('dogNameCache');
    if (!stored) return {};
    return JSON.parse(stored);
  } catch (e) {
    Logger.log('Dog name cache read error: ' + e.message);
    return {};
  }
}

/**
 * Persists the dog-name cache back to PropertiesService.
 * @param {Object} cacheObj - Map of { appointmentId: dogName }
 */
function saveDogNameCache_(cacheObj) {
  try {
    PropertiesService.getScriptProperties().setProperty(
      'dogNameCache',
      JSON.stringify(cacheObj)
    );
  } catch (e) {
    Logger.log('Dog name cache write error: ' + e.message);
  }
}

/** Finds the appointmentTypeID for "Boarding School". */
function getBoardingSchoolTypeId_() {
  return getAppointmentTypeId_(BOARDING_SCHOOL_TYPE_NAME, 'boardingSchoolTypeId');
}

/**
 * Formats a Date object as 'YYYY-MM-DD'.
 */
function formatDate_(date) {
  var y = date.getFullYear();
  var m = ('0' + (date.getMonth() + 1)).slice(-2);
  var d = ('0' + date.getDate()).slice(-2);
  return y + '-' + m + '-' + d;
}

/**
 * Extracts the "Dog Name" value from an individual appointment's
 * intake form data. Searches all forms/values for a field whose
 * name contains "dog name" (case-insensitive).
 *
 * @param {Object} appt - Full appointment object from /appointments/:id
 * @return {string|null} The dog name, or null if not found
 */
function extractDogName_(appt) {
  if (!appt.forms || !appt.forms.length) return null;

  for (var f = 0; f < appt.forms.length; f++) {
    var form = appt.forms[f];
    if (!form.values || !form.values.length) continue;

    for (var v = 0; v < form.values.length; v++) {
      var fieldName = (form.values[v].name || '').toLowerCase();
      // Match "Dog Name", "Dog's Name", "Dog name", etc.
      if (fieldName.indexOf('dog') !== -1 && fieldName.indexOf('name') !== -1) {
        var val = (form.values[v].value || '').trim();
        if (val) return val;
      }
    }
  }

  return null;
}

/**
 * ADDED: Helper to fetch appointments for a given type ID within a date range,
 * then fetch full details for dog names via fetchAll().
 * Returns an array of enriched records, each tagged with the provided stayType.
 *
 * @param {number} typeId       - Acuity appointment type ID
 * @param {string} minDate      - 'YYYY-MM-DD' start of range
 * @param {string} maxDate      - 'YYYY-MM-DD' end of range
 * @param {string} stayType     - 'boarding' or 'school' — attached to each record
 * @return {Array} Array of { appt, dogName, stayType } objects
 */
function fetchAppointmentsForType_(typeId, minDate, maxDate, stayType) {
  var appointments = acuityGet_('/appointments', {
    minDate: minDate,
    maxDate: maxDate,
    appointmentTypeID: typeId,
    max: MAX_APPOINTMENTS,
    direction: 'ASC'
  });

  if (!appointments || !appointments.length) return [];

  // Check the dog name cache — persisted in PropertiesService so it survives
  // across executions. Appointment IDs are stable and dog names for an ID
  // don't change, so most refreshes will hit the cache for every appointment
  // and skip the expensive per-appointment detail fetches entirely.
  var dogNameCache = getDogNameCache_();
  var dogNameCacheChanged = false;

  // Only fetch details for appointments we haven't cached
  var authHeader = getAcuityAuthHeader_();
  var fetchRequests = [];
  var fetchIndices = []; // track which appointments need fetching
  for (var i = 0; i < appointments.length; i++) {
    var apptId = String(appointments[i].id);
    if (!dogNameCache[apptId]) {
      fetchRequests.push({
        url: ACUITY_BASE_URL + '/appointments/' + apptId,
        method: 'get',
        headers: { 'Authorization': authHeader },
        muteHttpExceptions: true
      });
      fetchIndices.push(i);
    }
  }

  // Fetch only uncached appointment details
  if (fetchRequests.length > 0) {
    var detailResponses = UrlFetchApp.fetchAll(fetchRequests);

    for (var r = 0; r < detailResponses.length; r++) {
      if (detailResponses[r].getResponseCode() === 200) {
        try {
          var detail = JSON.parse(detailResponses[r].getContentText());
          var extracted = extractDogName_(detail);
          var apptId = String(appointments[fetchIndices[r]].id);
          if (extracted) {
            dogNameCache[apptId] = extracted;
            dogNameCacheChanged = true;
          }
        } catch (parseErr) {
          Logger.log('Failed to parse appointment detail: ' + parseErr.message);
        }
      }
    }

    // Persist the dog name cache only if we added new entries.
    if (dogNameCacheChanged) {
      saveDogNameCache_(dogNameCache);
    }
  }

  // Return enriched records tagged with the stay type
  var results = [];
  for (var i = 0; i < appointments.length; i++) {
    var apptId = String(appointments[i].id);
    results.push({
      appt: appointments[i],
      dogName: dogNameCache[apptId] || null,
      stayType: stayType
    });
  }

  return results;
}


// ============================================================
// BOARDING DATA
// MODIFIED: Now fetches both "Dog Boarding" and "Boarding School"
// appointment types and merges them into a single result set.
// Each stay includes a 'type' field: 'boarding' or 'school'.
// ============================================================

/**
 * Public entry point. Returns the boarding data, served from a 15-minute
 * script-level cache when available. The cache key includes today's date
 * so the cached payload auto-invalidates at midnight.
 *
 * Why this matters: every TV / browser / mobile whiteboard that hits
 * doGet used to trigger a fresh round-trip to Acuity (1 list call + 1
 * detail call per appointment). With this cache, only one client per
 * 15-minute window actually contacts Acuity — the rest are served from
 * cache for free, dramatically reducing quota usage.
 *
 * Errors are NOT cached so transient failures retry immediately.
 *
 * @return {Object} { stays: [...], dateRange, lastUpdated, error }
 */
function getBoardingData() {
  var cache = CacheService.getScriptCache();
  var today = new Date();
  today.setHours(0, 0, 0, 0);
  var cacheKey = 'boardingData_' + formatDate_(today);

  var cached = cache.get(cacheKey);
  if (cached) {
    try {
      return JSON.parse(cached);
    } catch (e) {
      Logger.log('Boarding data cache parse error: ' + e.message);
    }
  }

  var data = computeBoardingData_();

  // Only cache successful responses — we want errors to retry on next call.
  if (data && !data.error) {
    try {
      var cacheData = JSON.stringify(data);
      if (cacheData.length < CACHE_SIZE_LIMIT) {
        cache.put(cacheKey, cacheData, BOARDING_DATA_CACHE_SECONDS);
      } else {
        Logger.log('Boarding data too large for cache (' + cacheData.length + ' bytes), skipping cache');
      }
    } catch (e) {
      Logger.log('Boarding data cache write error: ' + e.message);
    }
  }

  return data;
}

/**
 * Fetches boarding appointments from Acuity for today + 6 days,
 * groups them into stays, and returns structured data.
 *
 * Internal — called by getBoardingData() which adds the cache layer.
 *
 * @return {Object} { stays: [...], dateRange: { start, end }, lastUpdated, error }
 */
function computeBoardingData_() {
  try {
    // 1. Date range: LOOKBACK_DAYS back to today + FORWARD_DAYS forward
    var today = new Date();
    today.setHours(0, 0, 0, 0);

    var startDate = new Date(today);
    startDate.setDate(startDate.getDate() - LOOKBACK_DAYS);

    var endDate = new Date(today);
    endDate.setDate(endDate.getDate() + FORWARD_DAYS);

    var minDate = formatDate_(startDate);
    var maxDate = formatDate_(endDate);

    var displayStart = formatDate_(today);
    var displayEnd = formatDate_(endDate);

    // 2. Find the boarding appointment type IDs
    var boardingTypeId = getBoardingTypeId_();
    var schoolTypeId = getBoardingSchoolTypeId_();  // ADDED

    // MODIFIED: Check that at least one type was found
    if (!boardingTypeId && !schoolTypeId) {
      return {
        stays: [],
        dateRange: { start: displayStart, end: displayEnd },
        lastUpdated: new Date().toISOString(),
        error: 'Could not find "Dog Boarding" or "Boarding School" appointment types in Acuity. Please check the type names match exactly.'
      };
    }

    // 3. Fetch appointments for both types and merge.
    //    MODIFIED: Uses the new helper to fetch each type separately,
    //    then combines the results into a single array.
    var allRecords = [];

    if (boardingTypeId) {
      var boardingRecords = fetchAppointmentsForType_(boardingTypeId, minDate, maxDate, 'boarding');
      allRecords = allRecords.concat(boardingRecords);
    }

    if (schoolTypeId) {
      var schoolRecords = fetchAppointmentsForType_(schoolTypeId, minDate, maxDate, 'school');
      allRecords = allRecords.concat(schoolRecords);
    }

    // 4. Group appointments by dog identity (Dog Name + client surname).
    //    Uses a composite key of displayName + stayType so a dog with both
    //    boarding and school stays appears as separate entries.
    var dogMap = {};

    for (var i = 0; i < allRecords.length; i++) {
      var record = allRecords[i];
      var appt = record.appt;
      var surname = (appt.lastName || '').trim();

      // Use the dog name from the individual lookup, fall back to firstName
      var dogName = record.dogName || (appt.firstName || '').trim();
      var displayName = dogName + ' ' + surname;

      var apptDate = appt.datetime ? appt.datetime.substring(0, 10) : null;
      if (!apptDate) continue;

      // Separate key per stay type so boarding and school stays don't merge
      var mapKey = displayName + '|' + record.stayType;

      if (!dogMap[mapKey]) {
        dogMap[mapKey] = {
          displayName: displayName,
          dates: [],
          stayType: record.stayType
        };
      }
      if (dogMap[mapKey].dates.indexOf(apptDate) === -1) {
        dogMap[mapKey].dates.push(apptDate);
      }
    }

    // 5. Group into consecutive stays
    var stays = [];

    var mapKeys = Object.keys(dogMap).sort();
    for (var d = 0; d < mapKeys.length; d++) {
      var entry = dogMap[mapKeys[d]];
      var name = entry.displayName;
      var dates = entry.dates.sort();

      if (dates.length === 0) continue;

      var stayStart = dates[0];
      var prevDate = dates[0];

      for (var j = 1; j <= dates.length; j++) {
        var currentDate = (j < dates.length) ? dates[j] : null;
        var isConsecutive = false;

        if (currentDate) {
          var prev = new Date(prevDate + 'T00:00:00');
          var curr = new Date(currentDate + 'T00:00:00');
          var diffDays = Math.round((curr - prev) / (1000 * 60 * 60 * 24));
          isConsecutive = (diffDays === 1);
        }

        if (!isConsecutive) {
          var lastDay = new Date(prevDate + 'T00:00:00');
          var checkOut = new Date(lastDay);
          checkOut.setDate(checkOut.getDate() + 1);

          stays.push({
            dogName: name,
            checkIn: stayStart,
            checkOut: formatDate_(checkOut),
            type: entry.stayType  // ADDED: 'boarding' or 'school'
          });

          if (currentDate) {
            stayStart = currentDate;
          }
        }

        prevDate = currentDate;
      }
    }

    // 6. Filter to stays within the 7-day display window
    var todayStr = formatDate_(today);
    var displayEndStr = displayEnd;
    stays = stays.filter(function(stay) {
      return stay.checkOut >= todayStr && stay.checkIn <= displayEndStr;
    });

    // 7. Sort by check-out date ascending, then dog name
    stays.sort(function(a, b) {
      if (a.checkOut < b.checkOut) return -1;
      if (a.checkOut > b.checkOut) return 1;
      return a.dogName.localeCompare(b.dogName);
    });

    return {
      stays: stays,
      dateRange: { start: displayStart, end: displayEnd },
      lastUpdated: new Date().toISOString(),
      error: null
    };

  } catch (e) {
    Logger.log('getBoardingData error: ' + e.message);
    return {
      stays: [],
      dateRange: { start: '', end: '' },
      lastUpdated: new Date().toISOString(),
      error: 'Failed to fetch boarding data: ' + e.message
    };
  }
}


// ============================================================
// JOTFORM FEEDING DATA
// ============================================================

/**
 * Fetches ALL submissions from the JotForm feeding requirements form.
 * Handles pagination (JotForm returns max 1000 per request).
 * Results are cached for 30 minutes to reduce API calls.
 *
 * @return {Array} Array of raw submission objects from JotForm
 */
/**
 * Fetches a page of JotForm submissions with retry logic.
 * @param {number} offset - Pagination offset
 * @param {number} limit  - Page size
 * @param {string} [createdAfter] - Optional ISO date filter for incremental fetching
 * @return {Array} Array of submission objects
 */
function fetchJotformPage_(offset, limit, createdAfter) {
  var filterObj = { 'status:ne': 'DELETED' };
  if (createdAfter) {
    filterObj['created_at:gt'] = createdAfter;
  }
  var filterStr = encodeURIComponent(JSON.stringify(filterObj));

  var url = JOTFORM_BASE_URL + '/form/' + JOTFORM_FORM_ID + '/submissions'
    + '?apiKey=' + JOTFORM_API_KEY
    + '&limit=' + limit
    + '&offset=' + offset
    + '&orderby=created_at'
    + '&filter=' + filterStr;

  var options = {
    method: 'get',
    muteHttpExceptions: true
  };

  var result = withRetry_(function() {
    var response = UrlFetchApp.fetch(url, options);
    var code = response.getResponseCode();

    if (code !== 200) {
      Logger.log('JotForm API error (' + code + '): ' + response.getContentText());
      throw new Error('JotForm API returned status ' + code);
    }

    try {
      var parsed = JSON.parse(response.getContentText());
    } catch (parseErr) {
      throw new Error('JotForm API returned invalid JSON (status ' + code + ')');
    }

    if (parsed.responseCode !== 200) {
      throw new Error('JotForm API error: ' + (parsed.message || 'Unknown error'));
    }

    return parsed;
  });

  return result.content || [];
}

function fetchJotformSubmissions_() {
  var cache = CacheService.getScriptCache();

  // Check cache first — feeding data doesn't change frequently
  var cached = cache.get('jotformFeedingData');
  var cachedTimestamp = cache.get('jotformLastFetched');
  var existingRecords = [];

  if (cached) {
    try {
      existingRecords = JSON.parse(cached);

      // If we have cached data and a timestamp, do an incremental fetch
      if (cachedTimestamp) {
        var newSubmissions = [];
        var offset = 0;
        var hasMore = true;

        while (hasMore) {
          var submissions = fetchJotformPage_(offset, JOTFORM_PAGE_LIMIT, cachedTimestamp);
          newSubmissions = newSubmissions.concat(submissions);
          hasMore = (submissions.length >= JOTFORM_PAGE_LIMIT);
          offset += JOTFORM_PAGE_LIMIT;
        }

        if (newSubmissions.length > 0) {
          // Parse new submissions and merge with existing
          for (var i = 0; i < newSubmissions.length; i++) {
            try {
              var record = parseFeedingRecord_(newSubmissions[i]);
              if (record) existingRecords.push(record);
            } catch (parseErr) {
              Logger.log('Skipping malformed submission ' + (newSubmissions[i].id || i) + ': ' + parseErr.message);
            }
          }

          // Update cache with merged records
          var now = new Date().toISOString();
          try {
            var cacheData = JSON.stringify(existingRecords);
            if (cacheData.length < CACHE_SIZE_LIMIT) {
              cache.put('jotformFeedingData', cacheData, FEEDING_CACHE_SECONDS);
              cache.put('jotformLastFetched', now, FEEDING_CACHE_SECONDS);
            }
          } catch (cacheErr) {
            Logger.log('Cache write error: ' + cacheErr.message);
          }
        }

        return existingRecords;
      }

      // Cache exists but no timestamp — return cached data as-is
      return existingRecords;
    } catch (e) {
      Logger.log('Cache parse error, fetching fresh: ' + e.message);
    }
  }

  // Full fetch — no cache or cache was invalid
  var allSubmissions = [];
  var offset = 0;
  var hasMore = true;

  while (hasMore) {
    var submissions = fetchJotformPage_(offset, JOTFORM_PAGE_LIMIT);
    allSubmissions = allSubmissions.concat(submissions);
    hasMore = (submissions.length >= JOTFORM_PAGE_LIMIT);
    offset += JOTFORM_PAGE_LIMIT;
  }

  // Validate that we got an array of submissions
  if (!Array.isArray(allSubmissions)) {
    Logger.log('JotForm returned unexpected data type: ' + typeof allSubmissions);
    return [];
  }

  // Parse all submissions into feeding records
  var feedingRecords = [];
  for (var i = 0; i < allSubmissions.length; i++) {
    try {
      var record = parseFeedingRecord_(allSubmissions[i]);
      if (record) {
        feedingRecords.push(record);
      }
    } catch (parseErr) {
      Logger.log('Skipping malformed submission ' + (allSubmissions[i].id || i) + ': ' + parseErr.message);
    }
  }

  // Cache the parsed records and timestamp
  var now = new Date().toISOString();
  try {
    var cacheData = JSON.stringify(feedingRecords);
    if (cacheData.length < CACHE_SIZE_LIMIT) {
      cache.put('jotformFeedingData', cacheData, FEEDING_CACHE_SECONDS);
      cache.put('jotformLastFetched', now, FEEDING_CACHE_SECONDS);
    } else {
      Logger.log('Feeding data too large for cache (' + cacheData.length + ' bytes), skipping cache');
    }
  } catch (cacheErr) {
    Logger.log('Cache write error: ' + cacheErr.message);
  }

  return feedingRecords;
}

/**
 * Parses a single JotForm submission into a clean feeding record object.
 * Maps field IDs to human-readable properties.
 *
 * JotForm field IDs for form 240635310347348:
 *   33 = Dog Name
 *   59 = Owner Surname (new field — may be empty on older submissions)
 *   48 = How Many Meals (radio: One Meal / Two Meals / Three Meals)
 *   51 = Type of Food (checkbox: Kibble, Wet Food - Sachet/Tray, etc.)
 *   52 = Kibble Measurement Type (radio: Cup / Handful / Scoop / No limit)
 *   53 = Kibble Cup Size (radio: Small / Medium / Large / No limit)
 *   43 = Kibble Quantity (dropdown: 1/2 Cup, Full Cup, 2-4 Cups)
 *   56 = Handful Times (dropdown: one-ten)
 *   55 = Kibble Quantity in Parent Scoop (dropdown: 1/2 - 4 Scoops)
 *   49 = Wet Food Quantity - Pouch/Tray (dropdown)
 *   50 = Wet Tin Food Quantity (dropdown)
 *   40 = Special Food Requirements / Additional Notes (textarea)
 *   38 = Medication (dropdown: Yes / No)
 *   26 = Medication Details (textarea)
 *
 * @param {Object} submission - Raw JotForm submission object
 * @return {Object|null} Parsed feeding record, or null if invalid
 */
function parseFeedingRecord_(submission) {
  // Skip deleted submissions — allow ACTIVE, CUSTOM, and other valid statuses
  // "CUSTOM" is JotForm's status for manually edited entries — perfectly valid
  if (submission.status === 'DELETED') return null;

  var answers = submission.answers;
  if (!answers) return null;

  // Helper: safely extract the answer value from a field
  function getAnswer(qid) {
    if (!answers[qid] || answers[qid].answer === undefined || answers[qid].answer === null) {
      return null;
    }
    return answers[qid].answer;
  }

  var dogName = getAnswer(JOTFORM_FIELDS.DOG_NAME);
  if (!dogName || (typeof dogName === 'string' && !dogName.trim())) return null;

  // Food types come as an array (checkbox field) or a string
  var foodTypesRaw = getAnswer(JOTFORM_FIELDS.FOOD_TYPES);
  var foodTypes = [];
  if (Array.isArray(foodTypesRaw)) {
    foodTypes = foodTypesRaw;
  } else if (typeof foodTypesRaw === 'string' && foodTypesRaw.trim()) {
    foodTypes = [foodTypesRaw.trim()];
  }

  return {
    dogName: (typeof dogName === 'string') ? dogName.trim() : String(dogName).trim(),
    ownerSurname: (getAnswer(JOTFORM_FIELDS.OWNER_SURNAME) || '').trim(),
    mealsPerDay: (getAnswer(JOTFORM_FIELDS.MEALS_PER_DAY) || '').trim(),
    foodTypes: foodTypes,
    kibbleMeasurement: (getAnswer(JOTFORM_FIELDS.KIBBLE_MEASUREMENT) || '').trim(),
    kibbleCupSize: (getAnswer(JOTFORM_FIELDS.KIBBLE_CUP_SIZE) || '').trim(),
    kibbleQuantity: (getAnswer(JOTFORM_FIELDS.KIBBLE_QUANTITY) || '').trim(),
    handfulTimes: (getAnswer(JOTFORM_FIELDS.HANDFUL_TIMES) || '').trim(),
    scoopQuantity: (getAnswer(JOTFORM_FIELDS.SCOOP_QUANTITY) || '').trim(),
    wetFood: (getAnswer(JOTFORM_FIELDS.WET_FOOD) || '').trim(),
    tinFood: (getAnswer(JOTFORM_FIELDS.TIN_FOOD) || '').trim(),
    specialNotes: (getAnswer(JOTFORM_FIELDS.SPECIAL_NOTES) || '').trim(),
    medication: (getAnswer(JOTFORM_FIELDS.MEDICATION) || '').trim(),
    medicationDetails: (getAnswer(JOTFORM_FIELDS.MEDICATION_DETAILS) || '').trim(),
    submittedAt: submission.created_at || ''
  };
}


// ============================================================
// MATCHING ENGINE
// ============================================================

/**
 * Matches boarding stays to JotForm feeding records.
 *
 * Acuity stores dog names as "DogFirstName OwnerSurname" (e.g. "Woody Richardson").
 * JotForm stores:
 *   - dogName: Could be just "Woody" OR "Woody Richardson" (owners often put
 *              both the dog name and their surname in the dog name field)
 *   - ownerSurname: "Richardson" (present on new submissions after field was added)
 *
 * Matching priority (highest to lowest):
 *   1. EXACT SURNAME: JotForm ownerSurname field matches + dog name matches
 *   2. FULL NAME IN DOG FIELD: JotForm dogName contains "DogName Surname"
 *      (e.g. "Frida Walsh" in the dog name field matches Acuity's "Frida Walsh")
 *   3. FIRST NAME ONLY: JotForm dogName first word matches Acuity dog name
 *      (fallback for older submissions without surname anywhere)
 *
 * When multiple records match at the same priority, the most recent submission wins.
 *
 * MODIFIED: Now passes through stay.type ('boarding' or 'school') to the dog object.
 *
 * @param {Array} stays - Boarding stays from getBoardingData()
 * @param {Array} feedingRecords - Parsed JotForm feeding records
 * @return {Array} Combined array of dog objects with feeding data attached
 */
function matchFeedingRecords_(stays, feedingRecords) {
  var results = [];

  // Match priority levels (lower = better)
  var MATCH_EXACT_SURNAME = 1;     // ownerSurname field matches
  var MATCH_FULLNAME_IN_FIELD = 2; // "Frida Walsh" in dog name field
  var MATCH_FIRST_NAME_ONLY = 3;   // dog first name only, no surname confirmation

  for (var i = 0; i < stays.length; i++) {
    var stay = stays[i];

    // Split Acuity's "DogName Surname" into parts
    // Normalize: trim, collapse multiple spaces, lowercase
    var normalizedName = stay.dogName.replace(/\s+/g, ' ').trim();
    var nameParts = normalizedName.split(' ');
    var acuityDogName = (nameParts[0] || '').toLowerCase().trim();
    var acuitySurname = nameParts.slice(1).join(' ').toLowerCase().trim();
    var acuityFullName = normalizedName.toLowerCase();

    var bestMatch = null;
    var bestMatchPriority = 999;
    var bestMatchDate = '';

    for (var j = 0; j < feedingRecords.length; j++) {
      var record = feedingRecords[j];
      // Normalize: trim, collapse multiple spaces, lowercase
      var jfDogNameRaw = record.dogName.replace(/\s+/g, ' ').toLowerCase().trim();
      var jfSurname = record.ownerSurname.replace(/\s+/g, ' ').toLowerCase().trim();

      // Extract the first word of the JotForm dog name for comparison
      var jfDogNameParts = jfDogNameRaw.split(' ');
      var jfDogFirstName = jfDogNameParts[0] || '';
      var jfDogExtraParts = jfDogNameParts.slice(1).join(' ');

      var matchPriority = 999;

      // --- Priority 1: Exact surname field match ---
      // Dog first name matches AND the separate ownerSurname field matches
      if (jfDogFirstName === acuityDogName && jfSurname && acuitySurname && jfSurname === acuitySurname) {
        matchPriority = MATCH_EXACT_SURNAME;
      }
      // --- Priority 2: Full name entered in the dog name field ---
      // e.g. JotForm dogName = "Frida Walsh", Acuity = "Frida Walsh"
      else if (jfDogNameRaw === acuityFullName) {
        matchPriority = MATCH_FULLNAME_IN_FIELD;
      }
      // Also check: JotForm dogName first word matches + extra parts match surname
      // e.g. JotForm dogName = "Barney Leeming", Acuity dogName = "Barney", surname = "Leeming"
      else if (jfDogFirstName === acuityDogName && jfDogExtraParts && acuitySurname && jfDogExtraParts === acuitySurname) {
        matchPriority = MATCH_FULLNAME_IN_FIELD;
      }
      // --- Priority 3: First name only (no surname confirmation) ---
      // Only use this if the JotForm entry has no surname info at all
      else if (jfDogFirstName === acuityDogName && !jfSurname && !jfDogExtraParts) {
        matchPriority = MATCH_FIRST_NAME_ONLY;
      }
      else {
        // No match — skip
        continue;
      }

      // Determine if this is better than what we already have
      var isBetter = false;

      if (!bestMatch) {
        isBetter = true;
      } else if (matchPriority < bestMatchPriority) {
        // Higher priority match always wins
        isBetter = true;
      } else if (matchPriority === bestMatchPriority && record.submittedAt > bestMatchDate) {
        // Same priority — most recent submission wins
        isBetter = true;
      }

      if (isBetter) {
        bestMatch = record;
        bestMatchPriority = matchPriority;
        bestMatchDate = record.submittedAt;
      }
    }

    // Count how many first-name-only matches we found (for ambiguity warning)
    var firstNameMatchCount = 0;
    if (bestMatchPriority === MATCH_FIRST_NAME_ONLY) {
      for (var k = 0; k < feedingRecords.length; k++) {
        var checkName = feedingRecords[k].dogName.replace(/\s+/g, ' ').toLowerCase().trim().split(' ')[0];
        var checkSurname = feedingRecords[k].ownerSurname.replace(/\s+/g, ' ').toLowerCase().trim();
        var checkExtraParts = feedingRecords[k].dogName.replace(/\s+/g, ' ').toLowerCase().trim().split(' ').slice(1).join(' ');
        if (checkName === acuityDogName && !checkSurname && !checkExtraParts) {
          firstNameMatchCount++;
        }
      }
    }

    // Build the combined dog object
    var dogObj = {
      dogName: nameParts[0] || stay.dogName,
      ownerSurname: nameParts.slice(1).join(' ') || '',
      checkIn: stay.checkIn,
      checkOut: stay.checkOut,
      type: stay.type || 'boarding',
      matched: bestMatch !== null,
      matchType: bestMatch ? (bestMatchPriority === MATCH_EXACT_SURNAME ? 'exact' :
                              bestMatchPriority === MATCH_FULLNAME_IN_FIELD ? 'fullname' : 'name_only') : 'none',
      ambiguousMatch: (firstNameMatchCount > 1)
    };

    if (bestMatch) {
      var kibbleSummary = buildKibbleSummary_(bestMatch);

      dogObj.feeding = {
        mealsPerDay: bestMatch.mealsPerDay,
        foodTypes: bestMatch.foodTypes,
        kibbleSummary: kibbleSummary,
        wetFood: bestMatch.wetFood,
        tinFood: bestMatch.tinFood,
        specialNotes: bestMatch.specialNotes,
        medication: bestMatch.medication,
        medicationDetails: bestMatch.medicationDetails
      };
    } else {
      dogObj.feeding = null;
    }

    results.push(dogObj);
  }

  return results;
}

/**
 * Builds a human-readable daily kibble quantity string from a feeding record.
 * Combines measurement type, cup size, and quantity into a clear summary.
 *
 * Examples:
 *   "2 Cups — Large Cup"
 *   "Three Handfuls"
 *   "Full Scoop (parent's scoop)"
 *   "No limit — all you can eat buffet"
 *
 * @param {Object} record - Parsed feeding record
 * @return {string} Human-readable kibble summary, or empty string
 */
function buildKibbleSummary_(record) {
  var measurement = record.kibbleMeasurement;

  if (!measurement) return '';

  // "No limit" option
  if (measurement.toLowerCase().indexOf('no limit') !== -1) {
    return 'No limit — all you can eat buffet';
  }

  // Cup measurement
  if (measurement === 'Cup') {
    var parts = [];
    if (record.kibbleQuantity) parts.push(record.kibbleQuantity);
    if (record.kibbleCupSize) {
      // Capitalise first letter
      var size = record.kibbleCupSize.charAt(0).toUpperCase() + record.kibbleCupSize.slice(1);
      parts.push(size + ' Cup');
    }
    return parts.join(' — ');
  }

  // Handful measurement
  if (measurement === 'Handful') {
    if (record.handfulTimes) {
      var times = record.handfulTimes.charAt(0).toUpperCase() + record.handfulTimes.slice(1);
      return times + ' Handful' + (record.handfulTimes.toLowerCase() !== 'one' ? 's' : '');
    }
    return 'Handful';
  }

  // Scoop (parent's scoop)
  if (measurement.toLowerCase().indexOf('scoop') !== -1) {
    if (record.scoopQuantity) {
      return record.scoopQuantity + " (parent's scoop)";
    }
    return "Parent's scoop";
  }

  return measurement;
}


// ============================================================
// FEEDING BOARD DATA (combines Acuity + JotForm)
// ============================================================

/**
 * Main function for the feeding board display.
 * Fetches boarding stays from Acuity, feeding records from JotForm,
 * matches them, and returns the combined data.
 *
 * @return {Object} {
 *   dogs: [...],
 *   dogCount: number,
 *   dateRange: { start, end },
 *   lastUpdated: string,
 *   error: string|null,
 *   feedingError: string|null
 * }
 */
function getFeedingBoardData() {
  var feedingError = null;

  try {
    // 1. Get boarding stays (reuses existing function)
    var boardingData = getBoardingData();

    if (boardingData.error) {
      return {
        dogs: [],
        dogCount: 0,
        dateRange: boardingData.dateRange,
        lastUpdated: new Date().toISOString(),
        error: boardingData.error,
        feedingError: null
      };
    }

    var stays = boardingData.stays || [];

    // 2. Fetch and parse JotForm feeding submissions
    var feedingRecords = [];
    try {
      feedingRecords = fetchJotformSubmissions_();
    } catch (jfErr) {
      Logger.log('JotForm fetch error: ' + jfErr.message);
      feedingError = 'Could not fetch feeding data from JotForm: ' + jfErr.message;
      // Continue — we'll show boarding dogs without feeding info
    }

    // 3. Match boarding dogs to feeding records
    var dogs = matchFeedingRecords_(stays, feedingRecords);

    // 4. Sort: medication dogs first, then matched, then unmatched
    dogs.sort(function(a, b) {
      // Medication dogs float to the top
      var aMed = (a.feeding && a.feeding.medication === 'Yes') ? 0 : 1;
      var bMed = (b.feeding && b.feeding.medication === 'Yes') ? 0 : 1;
      if (aMed !== bMed) return aMed - bMed;

      // Matched before unmatched
      var aMatched = a.matched ? 0 : 1;
      var bMatched = b.matched ? 0 : 1;
      if (aMatched !== bMatched) return aMatched - bMatched;

      // Then alphabetically by dog name
      return a.dogName.localeCompare(b.dogName);
    });

    return {
      dogs: dogs,
      dogCount: dogs.length,
      dateRange: boardingData.dateRange,
      lastUpdated: new Date().toISOString(),
      error: null,
      feedingError: feedingError
    };

  } catch (e) {
    Logger.log('getFeedingBoardData error: ' + e.message);
    return {
      dogs: [],
      dogCount: 0,
      dateRange: { start: '', end: '' },
      lastUpdated: new Date().toISOString(),
      error: 'Failed to build feeding board: ' + e.message,
      feedingError: feedingError
    };
  }
}


// ============================================================
// UTILITY: Manual test function (run from Script Editor)
// ============================================================

/**
 * Test function — run manually to check feeding board output.
 * View results in Logger (View → Logs) or Execution Log.
 */
function testFeedingBoard() {
  var data = getFeedingBoardData();
  Logger.log('Dog count: ' + data.dogCount);
  Logger.log('Error: ' + data.error);
  Logger.log('Feeding error: ' + data.feedingError);

  for (var i = 0; i < data.dogs.length; i++) {
    var dog = data.dogs[i];
    Logger.log('---');
    Logger.log(dog.dogName + ' ' + dog.ownerSurname + ' | type=' + dog.type + ' | matched=' + dog.matched + ' | matchType=' + dog.matchType);
    if (dog.feeding) {
      Logger.log('  Meals: ' + dog.feeding.mealsPerDay);
      Logger.log('  Food types: ' + dog.feeding.foodTypes.join(', '));
      Logger.log('  Kibble: ' + dog.feeding.kibbleSummary);
      Logger.log('  Wet: ' + dog.feeding.wetFood);
      Logger.log('  Tin: ' + dog.feeding.tinFood);
      Logger.log('  Notes: ' + dog.feeding.specialNotes);
      Logger.log('  Medication: ' + dog.feeding.medication + ' — ' + dog.feeding.medicationDetails);
    }
  }
}
