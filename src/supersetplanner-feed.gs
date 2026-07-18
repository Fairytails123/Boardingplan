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
var BOARDING_TYPE_CACHE_SECONDS = 21600; // 6 hours (CacheService max) for appointment type ID
var FULL_RESPONSE_CACHE_SECONDS = 18000; // 5 hours — TV polls 3×/day at 07/13/18, 5h cache absorbs any extra reloads
var STALE_CACHE_FALLBACK_SECONDS = 21600; // 6 hours — serve stale data when upstream fails

// --- Dog name cache lives in PropertiesService (not CacheService) so it
//     persists indefinitely. A given Acuity appointment ID's dog name never
//     changes, so caching forever is safe and eliminates repeat detail fetches
//     that were burning through Acuity's monthly bandwidth quota.
var DOG_NAME_PROPERTY_KEY = 'acuityDogNameCache';

// --- Date range for boarding data ---
var LOOKBACK_DAYS = 7;   // Only need stays overlapping today/tomorrow
var FORWARD_DAYS = 6;

// --- API fetch limits ---
var MAX_APPOINTMENTS = 500;
var JOTFORM_PAGE_LIMIT = 1000;
var CACHE_SIZE_LIMIT = 100000; // CacheService per-key limit in characters

// CacheService key for the full boarding response — shared by
// getBoardingData() and the check-in/out layer's read-only cache peek
// (peekBoardingCache_) so the two can never drift apart.
var FULL_RESPONSE_CACHE_KEY = 'fullBoardingResponse';

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
 * Supports three modes via the 'mode' query parameter:
 *   - 'boarding' (default): Boarding calendar data from Acuity
 *   - 'feeding': Boarding stays + matched JotForm feeding records
 *   - 'checkinout': Persisted stays snapshot + serve-time check-in/out
 *     buckets (see the CHECK-IN / CHECK-OUT SNAPSHOT section below)
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
  } else if (mode === 'checkinout') {
    // --- ADDED: Check-in / Check-out snapshot mode ---
    // Serves the persisted stays snapshot, bucketed for the CURRENT date at
    // request time, and always includes the full stays array (the documented
    // contract the external Feeding Report Manager reads). Freshness comes
    // free from the 5-hour boarding response cache when any boarding-mode
    // client has warmed it (opportunistic adoption, zero Acuity); otherwise
    // Acuity is only hit by the scheduled refresh triggers installed via
    // installRefreshTriggers(), or by the backoff-limited self-healing
    // inline refresh when the snapshot is missing or more than 14 h old.
    data = getCheckInOutData();
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
    var body = response.getContentText();

    if (code !== 200) {
      Logger.log('Acuity API error (' + code + '): ' + body);
      // Surface Acuity's error message (e.g. "Bandwidth quota exceeded...")
      // so callers can distinguish bandwidth issues from other failures.
      var detail = '';
      try {
        var parsed = JSON.parse(body);
        detail = parsed.message || parsed.error || '';
      } catch (_) {
        detail = body.substring(0, 200);
      }
      throw new Error('Acuity API status ' + code + (detail ? ': ' + detail : ''));
    }

    try {
      return JSON.parse(body);
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

  // Dog names never change for a given appointment ID, so we persist them in
  // PropertiesService (permanent) rather than CacheService (6 hour max). This
  // ensures we only fetch an appointment's detail ONCE — ever — which is the
  // critical fix for Acuity's "Bandwidth quota exceeded" error.
  var props = PropertiesService.getScriptProperties();
  var dogNameCache = {};
  try {
    var stored = props.getProperty(DOG_NAME_PROPERTY_KEY);
    if (stored) dogNameCache = JSON.parse(stored);
  } catch (e) {
    Logger.log('Dog name property cache parse error: ' + e.message);
  }

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

  // Fetch only uncached appointment details — in small batches with delays to avoid Acuity bandwidth limits
  if (fetchRequests.length > 0) {
    var BATCH_SIZE = 5;
    var allDetailResponses = [];

    for (var batchStart = 0; batchStart < fetchRequests.length; batchStart += BATCH_SIZE) {
      if (batchStart > 0) {
        Utilities.sleep(2000); // 2s pause between batches to stay under Acuity rate/bandwidth limits
      }
      var batchEnd = Math.min(batchStart + BATCH_SIZE, fetchRequests.length);
      var batch = fetchRequests.slice(batchStart, batchEnd);
      var batchResponses = UrlFetchApp.fetchAll(batch);
      allDetailResponses = allDetailResponses.concat(batchResponses);
    }

    for (var r = 0; r < allDetailResponses.length; r++) {
      if (allDetailResponses[r].getResponseCode() === 200) {
        try {
          var detail = JSON.parse(allDetailResponses[r].getContentText());
          var extracted = extractDogName_(detail);
          var apptId = String(appointments[fetchIndices[r]].id);
          if (extracted) {
            dogNameCache[apptId] = extracted;
          }
        } catch (parseErr) {
          Logger.log('Failed to parse appointment detail: ' + parseErr.message);
        }
      }
    }

    // Persist the dog name cache permanently — these mappings never change.
    try {
      props.setProperty(DOG_NAME_PROPERTY_KEY, JSON.stringify(dogNameCache));
    } catch (e) {
      Logger.log('Dog name property write error: ' + e.message);
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
 * Fetches boarding appointments from Acuity for today + 6 days,
 * groups them into stays, and returns structured data.
 *
 * @param {boolean} [forceFresh] - Skip the cache READ and always refetch
 *        (the fresh result still re-warms the 5-hour cache and the stale
 *        mirror for every other caller). Used by the scheduled check-in/out
 *        snapshot refresh so triggers persist genuinely fresh data.
 * @return {Object} { stays: [...], dateRange: { start, end }, lastUpdated, error }
 */
function getBoardingData(forceFresh) {
  // Check full boarding response cache first (skipped on forceFresh)
  var boardingCache = CacheService.getScriptCache();
  if (!forceFresh) {
    var cachedBoarding = boardingCache.get(FULL_RESPONSE_CACHE_KEY);
    if (cachedBoarding) {
      try {
        Logger.log('Returning cached boarding response');
        return JSON.parse(cachedBoarding);
      } catch (e) {
        Logger.log('Boarding cache parse error: ' + e.message);
      }
    }
  }

  try {
    // 1. Date range: 7 days back to today + 6 days forward
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

    var boardingResult = {
      stays: stays,
      dateRange: { start: displayStart, end: displayEnd },
      lastUpdated: new Date().toISOString(),
      error: null
    };

    // Cache so repeat calls (e.g. from getFeedingBoardData) don't re-fetch
    try {
      var brJson = JSON.stringify(boardingResult);
      if (brJson.length < CACHE_SIZE_LIMIT) {
        boardingCache.put(FULL_RESPONSE_CACHE_KEY, brJson, FULL_RESPONSE_CACHE_SECONDS);
      }
    } catch (cacheErr) {
      Logger.log('Boarding cache write error: ' + cacheErr.message);
    }

    // Mirror the successful response into PropertiesService so we can serve
    // stale data if Acuity throttles us on a later refresh.
    try {
      PropertiesService.getScriptProperties()
        .setProperty('lastGoodBoardingResponse', JSON.stringify(boardingResult));
    } catch (staleErr) {
      Logger.log('Stale boarding write error: ' + staleErr.message);
    }

    return boardingResult;

  } catch (e) {
    Logger.log('getBoardingData error: ' + e.message);

    // If Acuity is throttling us, fall back to the last good response so the
    // TV keeps showing yesterday's data rather than going blank.
    try {
      var stale = PropertiesService.getScriptProperties()
        .getProperty('lastGoodBoardingResponse');
      if (stale) {
        var staleParsed = JSON.parse(stale);
        staleParsed.error = 'Showing last known data — upstream error: ' + e.message;
        return staleParsed;
      }
    } catch (fallbackErr) {
      Logger.log('Stale boarding read error: ' + fallbackErr.message);
    }

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
 * Returns true if two strings are identical or differ by a single edit
 * (one insertion, deletion, or substitution). Used for the fuzzy-surname
 * fallback to absorb owner typos like "Wighthman" vs "Wightman".
 *
 * Guard: strings shorter than 4 chars must match exactly — fuzzy matching
 * short surnames (e.g. "Fox" vs "Cox") is too risky.
 *
 * @param {string} a
 * @param {string} b
 * @return {boolean}
 */
function oneEditApart_(a, b) {
  if (a === b) return true;
  if (a.length < 4 || b.length < 4) return false;
  if (Math.abs(a.length - b.length) > 1) return false;

  // Match common prefix
  var i = 0;
  while (i < a.length && i < b.length && a.charAt(i) === b.charAt(i)) i++;
  // Match common suffix (not overlapping the prefix)
  var j = 0;
  while (j < a.length - i && j < b.length - i &&
         a.charAt(a.length - 1 - j) === b.charAt(b.length - 1 - j)) j++;

  // At most one differing character remains in each string
  return (a.length - i - j) <= 1 && (b.length - i - j) <= 1;
}

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
  // Fallback tiers — only used when tiers 1-3 find nothing (see block below the main loop)
  var MATCH_FUZZY_SURNAME = 4;     // dog first name matches + surname is a 1-letter typo
  var MATCH_SURNAME_ONLY = 5;      // surname field matches (covers blank/wrong dog name in Acuity)

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

    // --- FALLBACK TIERS ---
    // Only run when the strict tiers (1-3) found nothing. These never override
    // a good match; they only rescue cards that would otherwise be empty.
    // Both are guarded to avoid attaching the wrong dog's feeding/medication info.
    if (!bestMatch && acuitySurname) {
      var fbMatch = null;
      var fbPriority = 999;
      var fbDate = '';
      var surnameOnlyCount = 0; // how many records share this surname (ambiguity guard)

      for (var m = 0; m < feedingRecords.length; m++) {
        var rec = feedingRecords[m];
        var rDogRaw = rec.dogName.replace(/\s+/g, ' ').toLowerCase().trim();
        var rSur = rec.ownerSurname.replace(/\s+/g, ' ').toLowerCase().trim();
        var rParts = rDogRaw.split(' ');
        var rFirst = rParts[0] || '';
        var rExtra = rParts.slice(1).join(' ');
        // Surname to compare for the fuzzy tier: the surname field if filled,
        // otherwise any trailing words in the dog-name field (e.g. "Shadow Wightman")
        var rSurnameForFuzzy = rSur || rExtra;

        var fp = 999;

        // Fallback A — dog first name matches AND surname is a near-miss (1 letter off).
        // Catches owner typos like JotForm "Wighthman" vs Acuity "Wightman".
        if (rFirst === acuityDogName && rSurnameForFuzzy &&
            oneEditApart_(rSurnameForFuzzy, acuitySurname)) {
          fp = MATCH_FUZZY_SURNAME;
        }
        // Fallback B — surname field exactly matches Acuity's owner surname,
        // regardless of dog name. Catches a blank/incorrect dog name in Acuity
        // (e.g. intake form left empty, so the board falls back to the owner's name).
        else if (rSur && rSur === acuitySurname) {
          fp = MATCH_SURNAME_ONLY;
          surnameOnlyCount++;
        }
        else {
          continue;
        }

        if (!fbMatch || fp < fbPriority || (fp === fbPriority && rec.submittedAt > fbDate)) {
          fbMatch = rec;
          fbPriority = fp;
          fbDate = rec.submittedAt;
        }
      }

      // Surname-only matches must be unambiguous — if an owner has more than one
      // dog with a feeding form under the same surname, we can't tell which is which,
      // so leave the card empty rather than risk showing the wrong dog's food/meds.
      if (fbMatch && !(fbPriority === MATCH_SURNAME_ONLY && surnameOnlyCount > 1)) {
        bestMatch = fbMatch;
        bestMatchPriority = fbPriority;
        bestMatchDate = fbDate;
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
                              bestMatchPriority === MATCH_FULLNAME_IN_FIELD ? 'fullname' :
                              bestMatchPriority === MATCH_FUZZY_SURNAME ? 'fuzzy' :
                              bestMatchPriority === MATCH_SURNAME_ONLY ? 'surname' : 'name_only') : 'none',
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
  // --- Full response cache: avoid hitting Acuity/JotForm on every TV refresh ---
  var cache = CacheService.getScriptCache();
  var cachedResponse = cache.get('fullFeedingResponse');
  if (cachedResponse) {
    try {
      Logger.log('Returning cached feeding board response');
      return JSON.parse(cachedResponse);
    } catch (e) {
      Logger.log('Cached response parse error, fetching fresh: ' + e.message);
    }
  }

  var feedingError = null;

  try {
    // 1. Get boarding stays (reuses existing function)
    var boardingData = getBoardingData();

    // Only bail out when boarding truly has no data. If the stale-cache fallback
    // kicked in, boardingData.error will be set BUT stays will still be populated
    // — let that through so the TV keeps showing last known dogs.
    if (boardingData.error && (!boardingData.stays || boardingData.stays.length === 0)) {
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
    var upstreamWarning = boardingData.error || null;

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

    var result = {
      dogs: dogs,
      dogCount: dogs.length,
      dateRange: boardingData.dateRange,
      lastUpdated: new Date().toISOString(),
      error: upstreamWarning,
      feedingError: feedingError
    };

    // Cache the full response so subsequent TV refreshes don't hit APIs
    try {
      var resultJson = JSON.stringify(result);
      if (resultJson.length < CACHE_SIZE_LIMIT) {
        cache.put('fullFeedingResponse', resultJson, FULL_RESPONSE_CACHE_SECONDS);
        Logger.log('Cached full feeding response (' + resultJson.length + ' chars, TTL ' + FULL_RESPONSE_CACHE_SECONDS + 's)');
      }
      // Only mirror a CLEAN response (no upstream warning) to the stale-fallback
      // store — otherwise we'd overwrite good data with already-stale data.
      if (!upstreamWarning) {
        PropertiesService.getScriptProperties()
          .setProperty('lastGoodFeedingResponse', resultJson);
      }
    } catch (cacheErr) {
      Logger.log('Could not cache full response: ' + cacheErr.message);
    }

    return result;

  } catch (e) {
    Logger.log('getFeedingBoardData error: ' + e.message);

    // Fall back to last good response so the TV keeps showing feeding data
    // when Acuity throttles us. Better to show yesterday's dogs than nothing.
    try {
      var stale = PropertiesService.getScriptProperties()
        .getProperty('lastGoodFeedingResponse');
      if (stale) {
        var staleParsed = JSON.parse(stale);
        staleParsed.error = 'Showing last known data — upstream error: ' + e.message;
        staleParsed.feedingError = feedingError;
        return staleParsed;
      }
    } catch (fallbackErr) {
      Logger.log('Stale feeding read error: ' + fallbackErr.message);
    }

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


// ============================================================
// ADDED: CHECK-IN / CHECK-OUT SNAPSHOT
// ------------------------------------------------------------
// The TV display board ("Check-in / Out" tab) and the external
// Feeding Report Manager both call
//   ?mode=checkinout&token=...
//
// The response ALWAYS carries BOTH:
//   - stays: the full boarding stays list, verbatim from
//     getBoardingData() — the documented external contract
//     ({ dogName, checkIn, checkOut, type }) that the Feeding
//     Report Manager's breakfast/dinner rosters and the TV's
//     going-home index read. Mid-stay dogs exist ONLY here
//     (they are in none of the four buckets), so this key must
//     never be dropped from the response.
//   - the four boundary-day buckets derived from those stays
//     for the CURRENT Europe/London date at request time:
//       checkInToday      (stay.checkIn === today)
//       checkOutToday     (stay.checkOut === today)
//       checkInTomorrow   (stay.checkIn === tomorrow)
//       checkOutTomorrow  (stay.checkOut === tomorrow)
//
// Only the RAW STAYS are persisted (PropertiesService); the
// buckets are recomputed on every request, so a snapshot
// fetched at 19:00 still yields the correct buckets the next
// morning — the stored data can age, the date arithmetic
// cannot.
//
// Acuity budget (the quota is scarce — it exhausts quickly under
// bursts, so every mechanism below is designed to spend at most
// a fixed, predictable number of calls):
//   - Three scheduled triggers (07:xx, 13:xx, 19:xx Europe/London)
//     installed via installRefreshTriggers() — each SKIPS its
//     fetch when the snapshot is already <65 min old, so the
//     scheduled spend is ≤3 calls/day and often less.
//   - OPPORTUNISTIC ADOPTION (zero Acuity): every serve peeks the
//     5-hour boarding response cache (read-only, never fetching); when
//     any boarding-mode client has warmed it with data newer than
//     the snapshot, the snapshot silently adopts it. While the TV
//     is on, freshness rides other tabs' traffic for free.
//   - A self-healing inline refresh runs when the snapshot is
//     missing OR older than 14 h (triggers missing/broken). It
//     reads THROUGH the 5-hour boarding response cache and is
//     rate-limited by a 10-minute failure backoff, so even the TV
//     client's 15-second no-data retry loop cannot hammer Acuity
//     during an outage (≤6 attempts/hour).
//   - Duplicate triggers (e.g. installed by two different Google
//     accounts — invisible to each other's getProjectTriggers())
//     collapse into no-ops via the 65-min dedupe + a script lock.
// A failed Acuity fetch is NEVER persisted: the last good
// snapshot keeps being served (without an error field, so the
// TV keeps rendering) until a later refresh succeeds.
// ============================================================

// PropertiesService keys: the persisted stays snapshot, the last failed
// refresh attempt (failure backoff), and the trigger-install stamp.
var CHECKINOUT_SNAPSHOT_KEY = 'checkinoutSnapshot';
var CHECKINOUT_FAIL_AT_KEY = 'checkinoutLastFailAt';
var CHECKINOUT_INSTALL_STAMP_KEY = 'checkinoutTriggersInstalledAt';

// Refresh trigger handler name — referenced by installRefreshTriggers()
var CHECKINOUT_TRIGGER_HANDLER = 'refreshCheckInOutSnapshot';

// Refresh hours (Europe/London — the project's configured timezone).
// Three daily triggers: morning, midday (intraday freshness floor so a
// same-day booking/cancellation surfaces by early afternoon at the latest),
// evening. NOTE: Apps Script fires an atHour() trigger at an arbitrary
// minute WITHIN that hour.
var CHECKINOUT_MORNING_HOUR = 7;
var CHECKINOUT_MIDDAY_HOUR = 13;
var CHECKINOUT_EVENING_HOUR = 19;

// Serve-time staleness threshold. The longest healthy gap between triggers
// is overnight 19:xx → 07:xx (~13 h worst case with in-hour jitter), so an
// age above this means the triggers are missing or broken → self-heal.
var CHECKINOUT_STALE_MS = 14 * 60 * 60 * 1000;

// A trigger-invoked refresh SKIPS its Acuity fetch when the snapshot is
// younger than this. Wider than the worst in-hour jitter spread (59 min),
// so two accounts' duplicate triggers in the same hour cost one fetch, and
// a trigger firing just after an opportunistic adoption spends nothing.
// Manual editor runs are exempt (they always fetch).
var CHECKINOUT_TRIGGER_DEDUPE_MS = 65 * 60 * 1000;

// After a FAILED fetch, non-trigger refresh attempts (the serve-path
// self-heal) skip Acuity entirely for this long. Caps outage-time spend at
// ~6 attempts/hour even under the TV's 15-second no-data retry loop.
var CHECKINOUT_FAIL_BACKOFF_MS = 10 * 60 * 1000;

// Script Properties allows ~9 KB per value; refuse to persist anything
// bigger so the write cannot throw. (JSON here is ASCII-safe: char count ≈
// bytes.) An unpersistably large stays list degrades gracefully — see
// persistCheckInOutSnapshot_().
var CHECKINOUT_PROPS_VALUE_LIMIT = 8900;

/**
 * Reads and validates the persisted snapshot record. Returns
 * { stays, dateRange, fetchedAt } or null. Legacy/corrupt values (e.g. a
 * pre-rework bucket snapshot with no stays array) are ignored — callers
 * treat null as "missing" and rebuild, so old shapes self-migrate.
 */
function readStoredCheckInOutSnapshot_() {
  try {
    var raw = PropertiesService.getScriptProperties().getProperty(CHECKINOUT_SNAPSHOT_KEY);
    if (!raw) return null;
    var parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.stays)) return parsed;
  } catch (e) {
    Logger.log('[checkinout] snapshot read/parse failed: ' + e.message);
  }
  return null;
}

/**
 * Age of a stored snapshot record in ms, or NaN when unknowable.
 * Comparisons against NaN are false, so callers must test the healthy
 * range POSITIVELY (0 <= age <= limit) — never the inverse.
 */
function snapshotAgeMs_(stored) {
  if (!stored || !stored.fetchedAt) return NaN;
  return Date.now() - new Date(stored.fetchedAt).getTime();
}

/**
 * READ-ONLY peek at getBoardingData's cached response (the 5-hour-TTL
 * FULL_RESPONSE_CACHE_KEY entry). Never fetches, never writes — returns the
 * cached success payload or null. This is the zero-Acuity freshness source:
 * whenever any boarding-mode client (the TV's BOARDING PLAN iframe, the
 * standalone planner page, or a ?mode=feeding call) fetched within the
 * cache TTL, the check-in/out layer can adopt that data without spending a
 * call of its own.
 */
function peekBoardingCache_() {
  try {
    var raw = CacheService.getScriptCache().get(FULL_RESPONSE_CACHE_KEY);
    if (!raw) return null;
    var parsed = JSON.parse(raw);
    // Only successful payloads are ever cached, but guard anyway.
    if (parsed && !parsed.error && Array.isArray(parsed.stays)) return parsed;
  } catch (e) {
    Logger.log('[checkinout] boarding cache peek failed: ' + e.message);
  }
  return null;
}

/**
 * True when a peeked boarding payload is strictly fresher than the stored
 * snapshot record (or the record is missing/unstamped/garbled). A peek
 * without a lastUpdated stamp is never considered newer.
 */
function peekIsNewer_(peeked, stored) {
  if (!peeked) return false;
  if (!stored || !stored.fetchedAt) return true;
  var storedTime = new Date(stored.fetchedAt).getTime();
  if (isNaN(storedTime)) return true;
  var peekTime = new Date(peeked.lastUpdated || 0).getTime();
  return peekTime > storedTime;
}

/**
 * Builds the persistable record from a SUCCESSFUL boarding payload.
 */
function makeSnapshotRecord_(boardingData) {
  return {
    stays: (boardingData && boardingData.stays) || [],
    dateRange: (boardingData && boardingData.dateRange) || { start: '', end: '' },
    fetchedAt: (boardingData && boardingData.lastUpdated) || new Date().toISOString()
  };
}

/**
 * Persists a snapshot record to Script Properties. Refuses oversized
 * payloads (~9 KB per-value limit) instead of letting setProperty throw:
 * the previous snapshot then keeps serving and, once it crosses the 14 h
 * staleness threshold, every serve self-heals THROUGH the 5-hour response
 * cache — i.e. the endpoint degrades to cached request-time behaviour (at
 * most ~5 fetches/day) rather than freezing on old data.
 *
 * @return {boolean} true if persisted
 */
function persistCheckInOutRecord_(record) {
  var json = JSON.stringify(record);
  if (json.length > CHECKINOUT_PROPS_VALUE_LIMIT) {
    Logger.log('[checkinout] snapshot NOT persisted — ' + json.length +
               ' chars exceeds the ~9 KB Script Properties limit (' +
               record.stays.length + ' stays). Serving degrades to cached' +
               ' request-time fetching until the stays list shrinks.');
    return false;
  }
  try {
    PropertiesService.getScriptProperties().setProperty(CHECKINOUT_SNAPSHOT_KEY, json);
    Logger.log('[checkinout] snapshot stored: ' + record.stays.length +
               ' stays, fetched at ' + record.fetchedAt);
    return true;
  } catch (e) {
    Logger.log('[checkinout] snapshot write FAILED — previous snapshot still serving: ' + e.message);
    return false;
  }
}

/**
 * Serve-shape payload from a stored snapshot record: buckets computed for
 * the CURRENT date + the stays passthrough. No fetching, no writes.
 */
function servePayloadFromStored_(stored) {
  var data = buildCheckInOutBuckets_({
    stays: stored.stays,
    dateRange: stored.dateRange,
    lastUpdated: stored.fetchedAt || null,
    error: null
  });
  data.snapshotRefreshedAt = stored.fetchedAt || null;
  return data;
}

/**
 * Builds the check-in/out payload from a getBoardingData() result: the full
 * stays list passed through verbatim, plus the four boundary-day buckets for
 * the given reference date. No Acuity calls. Deterministic for a fixed
 * boardingData + referenceDate (lastUpdated is taken from boardingData).
 *
 * @param {Object} boardingData - The result of getBoardingData()
 * @param {Date}   [referenceDate] - Optional override for "today"; defaults to now
 * @return {Object} { stays, today, tomorrow, checkInToday, checkOutToday,
 *                    checkInTomorrow, checkOutTomorrow, counts, dateRange,
 *                    lastUpdated, error }
 */
function buildCheckInOutBuckets_(boardingData, referenceDate) {
  // Reference dates use formatDate_ — the SAME formatter that produced
  // stay.checkIn / stay.checkOut in getBoardingData — so the equality
  // comparisons below can never diverge from the stays, whatever timezone
  // the script project is configured with (Europe/London per appsscript.json).
  var now = referenceDate || new Date();
  var todayStr = formatDate_(now);

  var tomorrow = new Date(now.getTime());
  tomorrow.setDate(tomorrow.getDate() + 1);
  var tomorrowStr = formatDate_(tomorrow);

  var stays = (boardingData && boardingData.stays) ? boardingData.stays : [];

  var checkInToday = [];
  var checkOutToday = [];
  var checkInTomorrow = [];
  var checkOutTomorrow = [];

  for (var i = 0; i < stays.length; i++) {
    var stay = stays[i];

    // checkIn = the first booked night; the dog arrives that day.
    // checkOut = the day AFTER the final booked night; the dog leaves that day.
    // (This matches the existing semantics in getBoardingData().)
    if (stay.checkIn === todayStr) {
      checkInToday.push(stay);
    }
    if (stay.checkOut === todayStr) {
      checkOutToday.push(stay);
    }
    if (stay.checkIn === tomorrowStr) {
      checkInTomorrow.push(stay);
    }
    if (stay.checkOut === tomorrowStr) {
      checkOutTomorrow.push(stay);
    }
  }

  // Sort each bucket alphabetically by dog name for stable display
  function byName(a, b) { return (a.dogName || '').localeCompare(b.dogName || ''); }
  checkInToday.sort(byName);
  checkOutToday.sort(byName);
  checkInTomorrow.sort(byName);
  checkOutTomorrow.sort(byName);

  return {
    // Full stays list, verbatim — the external Feeding Report Manager and the
    // TV's going-home index read this key; the buckets alone cannot replace
    // it (mid-stay dogs appear in no bucket).
    stays: stays,
    today: todayStr,
    tomorrow: tomorrowStr,
    checkInToday: checkInToday,
    checkOutToday: checkOutToday,
    checkInTomorrow: checkInTomorrow,
    checkOutTomorrow: checkOutTomorrow,
    // Derived values only — always computed here from the final bucket
    // arrays (nothing mutates the buckets after this return, and counts are
    // never persisted or maintained as separate state). Kept for log and
    // client convenience.
    counts: {
      checkInToday: checkInToday.length,
      checkOutToday: checkOutToday.length,
      checkInTomorrow: checkInTomorrow.length,
      checkOutTomorrow: checkOutTomorrow.length
    },
    dateRange: (boardingData && boardingData.dateRange) || { start: '', end: '' },
    lastUpdated: (boardingData && boardingData.lastUpdated) || new Date().toISOString(),
    error: (boardingData && boardingData.error) || null
  };
}

/**
 * Scheduled trigger handler (and manual editor entry point).
 *
 * Trigger invocations (detected via the time-driven event object's
 * triggerUid) SKIP the fetch when the snapshot is already <65 min old —
 * so duplicate triggers (e.g. installed by two Google accounts) and a
 * trigger firing just after an opportunistic cache adoption spend nothing.
 * Manual editor runs are exempt from the dedupe and always force a
 * genuinely fresh Acuity fetch (bypassing the 5-hour boarding cache).
 *
 * @param {Object} [e] - Time-driven trigger event (absent on manual runs)
 * @return {Object} The serve-shape payload, for logging / inspection
 */
function refreshCheckInOutSnapshot(e) {
  return refreshCheckInOutSnapshot_(true, !!(e && e.triggerUid));
}

/**
 * Fetches boarding data, persists the RAW STAYS to PropertiesService, and
 * returns the full serve-shape payload (stays + buckets for right now).
 *
 * The returned payload carries an `error` IF AND ONLY IF no fresh data was
 * obtained (failed fetch, failure backoff, or another refresh holds the
 * lock) — getCheckInOutData() falls back to the stored snapshot in that
 * case. A failed fetch is NEVER persisted (mirroring getBoardingData's
 * only-cache-successes rule one layer up) but IS stamped so the failure
 * backoff can rate-limit serve-path retries.
 *
 * @param {boolean} forceFresh - true (triggers / manual runs) bypasses the
 *        5-hour boarding response cache; false (self-heal on the serve
 *        path) reads through it so request-time healing stays cheap.
 * @param {boolean} [triggerInvoked] - true only for time-driven trigger
 *        invocations; enables the 65-min dedupe skip.
 * @return {Object} The serve-shape payload, for logging / inspection
 */
function refreshCheckInOutSnapshot_(forceFresh, triggerInvoked) {
  var props = PropertiesService.getScriptProperties();
  var startedAt = new Date().toISOString();

  // Duplicate-trigger dedupe (quota, not correctness): skip the fetch when
  // the snapshot is already fresher than the dedupe window.
  if (triggerInvoked) {
    var already = readStoredCheckInOutSnapshot_();
    var age = snapshotAgeMs_(already);
    if (age >= 0 && age <= CHECKINOUT_TRIGGER_DEDUPE_MS) {
      Logger.log('[checkinout] trigger refresh skipped — snapshot only ' +
                 Math.round(age / 60000) + ' min old (dedupe window ' +
                 Math.round(CHECKINOUT_TRIGGER_DEDUPE_MS / 60000) + ' min)');
      return servePayloadFromStored_(already);
    }
  }

  // Failure backoff (serve-path self-heal only): after a failed fetch, skip
  // Acuity entirely for a while so the TV's 15-second no-data retry loop
  // cannot hammer the API during an outage. Trigger/manual runs are exempt.
  if (!forceFresh) {
    var failRaw = props.getProperty(CHECKINOUT_FAIL_AT_KEY);
    if (failRaw) {
      var failAge = Date.now() - new Date(failRaw).getTime();
      if (failAge >= 0 && failAge < CHECKINOUT_FAIL_BACKOFF_MS) {
        Logger.log('[checkinout] self-heal fetch skipped — last attempt failed ' +
                   Math.round(failAge / 60000) + ' min ago (backoff ' +
                   Math.round(CHECKINOUT_FAIL_BACKOFF_MS / 60000) + ' min)');
        return buildCheckInOutBuckets_({
          stays: [],
          error: 'Refresh backed off after a recent failed fetch'
        });
      }
    }
  }

  // Serialise refreshes. A rival trigger/self-heal already in flight will
  // store fresh data anyway, so failing to acquire the lock means "skip",
  // never "fetch twice".
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    Logger.log('[checkinout] refresh skipped — another refresh holds the lock');
    return buildCheckInOutBuckets_({
      stays: [],
      error: 'Another refresh is already in progress'
    });
  }

  try {
    // Re-check the dedupe under the lock — the rival we just waited for may
    // have refreshed the snapshot moments ago.
    if (triggerInvoked) {
      var rechecked = readStoredCheckInOutSnapshot_();
      var age2 = snapshotAgeMs_(rechecked);
      if (age2 >= 0 && age2 <= CHECKINOUT_TRIGGER_DEDUPE_MS) {
        Logger.log('[checkinout] trigger refresh skipped after lock — a rival refresh just completed');
        return servePayloadFromStored_(rechecked);
      }
    }

    Logger.log('[checkinout] refresh started at ' + startedAt +
               (forceFresh ? ' (forced fresh fetch)' : ' (via boarding response cache)'));

    // Re-use the existing Acuity-backed function — single source of truth
    // for stay shape, date window, and type handling.
    var boardingData = getBoardingData(forceFresh);

    if (!boardingData || boardingData.error) {
      var reason = (boardingData && boardingData.error) || 'getBoardingData() returned nothing';
      Logger.log('[checkinout] refresh FAILED — previous snapshot kept: ' + reason);
      try {
        props.setProperty(CHECKINOUT_FAIL_AT_KEY, new Date().toISOString());
      } catch (ignored) {
        // A failed stamp only weakens the backoff — never worth throwing for.
      }
      return buildCheckInOutBuckets_(boardingData || { stays: [], error: reason });
    }

    var record = makeSnapshotRecord_(boardingData);
    persistCheckInOutRecord_(record);

    var data = buildCheckInOutBuckets_(boardingData);
    data.snapshotRefreshedAt = record.fetchedAt;
    return data;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Returns the check-in/out payload for the doGet endpoint.
 *
 * Strategy:
 *   1. Read the persisted stays from PropertiesService and bucket them for
 *      the CURRENT date — instant, zero Acuity calls, and immune to the
 *      snapshot ageing across midnight (buckets are never stale-dated).
 *   2. Self-heal with an inline refresh when the snapshot is missing (first
 *      request after deploy) or older than CHECKINOUT_STALE_MS (scheduled
 *      triggers missing/broken). The inline refresh reads through
 *      getBoardingData's 5-hour response cache, so it stays cheap even if
 *      it runs on every request.
 *   3. A failed refresh never masks good data: while any stored snapshot
 *      exists it is served WITHOUT an error field (the TV client treats any
 *      error as total failure); the error is only surfaced when there is
 *      nothing at all to serve, so the client retries.
 *
 * @return {Object} { stays, today, tomorrow, checkInToday, checkOutToday,
 *                    checkInTomorrow, checkOutTomorrow, counts, dateRange,
 *                    lastUpdated, snapshotRefreshedAt, error }
 */
function getCheckInOutData() {
  var stored = readStoredCheckInOutSnapshot_();

  // OPPORTUNISTIC ADOPTION (zero Acuity): if any boarding-mode client warmed
  // the boarding response cache with data NEWER than the snapshot, adopt it —
  // both freshens a healthy snapshot and heals a stale/missing one for free.
  var peeked = peekBoardingCache_();
  if (peekIsNewer_(peeked, stored)) {
    var adopted = makeSnapshotRecord_(peeked);
    // A refused (oversized) persist is harmless — we still serve `adopted`
    // from memory below, and the next serve simply re-adopts.
    persistCheckInOutRecord_(adopted);
    stored = adopted;
    Logger.log('[checkinout] adopted fresher boarding-cache data (fetched ' +
               adopted.fetchedAt + ') — zero Acuity spent');
  }

  // NaN-safe: a missing/garbled fetchedAt fails the range check → unhealthy.
  var ageMs = snapshotAgeMs_(stored);
  var healthy = (ageMs >= 0 && ageMs <= CHECKINOUT_STALE_MS);

  if (!healthy) {
    Logger.log('[checkinout] snapshot ' + (stored ? 'stale/unstamped' : 'missing') +
               ' — inline self-heal refresh');
    var fresh = refreshCheckInOutSnapshot_(false);
    if (!fresh.error) return fresh;
    if (!stored) return fresh; // nothing better exists — surface the error so the client retries
    // Refresh failed but an older good snapshot exists: fall through and
    // serve it without an error so the board keeps showing real dogs.
  }

  return servePayloadFromStored_(stored);
}

/**
 * One-time setup — run this manually from the Apps Script editor to install
 * the three daily refresh triggers (07:xx, 13:xx and 19:xx Europe/London —
 * Apps Script picks the exact minute within each hour; the midday trigger
 * is the intraday freshness floor).
 *
 * Idempotent PER GOOGLE ACCOUNT: getProjectTriggers() only sees the running
 * account's triggers, so always install/remove from the same account. If a
 * different account's triggers already exist this logs a loud warning —
 * accidental duplicates cost no extra Acuity calls (the 65-min dedupe in
 * the handler collapses them), but clean-up must run from the account that
 * owns them.
 *
 * Scheduled spend: at most 3 Acuity calls/day — each trigger skips its
 * fetch when the snapshot is already <65 min old (e.g. just refreshed by
 * an opportunistic boarding-cache adoption).
 */
function installRefreshTriggers() {
  var props = PropertiesService.getScriptProperties();
  var existingStamp = props.getProperty(CHECKINOUT_INSTALL_STAMP_KEY);
  var removed = removeRefreshTriggers();

  if (existingStamp && removed === 0) {
    Logger.log('[checkinout] ⚠ WARNING: an install stamp from ' + existingStamp +
               ' exists but THIS account sees no triggers to replace — the live' +
               ' triggers were probably installed by a DIFFERENT Google account' +
               ' (or deleted by hand). Installing another set now is safe for' +
               ' Acuity quota (the 65-min dedupe collapses duplicates), but the' +
               ' redundant executions remain until removeRefreshTriggers() is' +
               ' run from the original account.');
  }

  ScriptApp.newTrigger(CHECKINOUT_TRIGGER_HANDLER)
    .timeBased()
    .atHour(CHECKINOUT_MORNING_HOUR)
    .everyDays(1)
    .create();

  ScriptApp.newTrigger(CHECKINOUT_TRIGGER_HANDLER)
    .timeBased()
    .atHour(CHECKINOUT_MIDDAY_HOUR)
    .everyDays(1)
    .create();

  ScriptApp.newTrigger(CHECKINOUT_TRIGGER_HANDLER)
    .timeBased()
    .atHour(CHECKINOUT_EVENING_HOUR)
    .everyDays(1)
    .create();

  props.setProperty(CHECKINOUT_INSTALL_STAMP_KEY, new Date().toISOString());

  // Prime the snapshot straight away so the first TV poll has data to show
  // (manual-style call: always fetches fresh, exempt from the dedupe).
  refreshCheckInOutSnapshot();

  Logger.log('[checkinout] installed three daily triggers in the ' +
             CHECKINOUT_MORNING_HOUR + ':00, ' + CHECKINOUT_MIDDAY_HOUR +
             ':00 and ' + CHECKINOUT_EVENING_HOUR +
             ':00 hours Europe/London (exact minute chosen by Apps Script)');
}

/**
 * Removes THIS ACCOUNT'S refreshCheckInOutSnapshot triggers. Triggers
 * installed by a different Google account are invisible here and survive —
 * run this signed in as the installing account. Clears the install stamp
 * only when triggers were actually removed.
 *
 * @return {number} How many triggers were removed
 */
function removeRefreshTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  var removed = 0;
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === CHECKINOUT_TRIGGER_HANDLER) {
      ScriptApp.deleteTrigger(triggers[i]);
      removed++;
    }
  }
  var props = PropertiesService.getScriptProperties();
  var stamp = props.getProperty(CHECKINOUT_INSTALL_STAMP_KEY);
  if (removed > 0) {
    try {
      props.deleteProperty(CHECKINOUT_INSTALL_STAMP_KEY);
    } catch (ignored) {
      // Stamp is advisory only.
    }
  } else if (stamp) {
    Logger.log('[checkinout] removed 0 triggers but an install stamp from ' +
               stamp + ' exists — the live triggers likely belong to a' +
               ' different Google account; run removeRefreshTriggers() from' +
               ' that account.');
  }
  Logger.log('[checkinout] removed ' + removed + ' existing trigger(s)');
  return removed;
}

/**
 * Test helper — run from the Apps Script editor to force a fresh Acuity
 * fetch, REBUILD AND PERSIST the snapshot (side effect: overwrites the
 * stored stays on success; a failed fetch leaves it untouched), and log the
 * four buckets. Does not touch the triggers. To LOOK at the current state
 * without spending an Acuity call or writing anything, use
 * inspectCheckInOutSnapshot() instead.
 */
function testCheckInOutRefresh() {
  var snapshot = refreshCheckInOutSnapshot();
  Logger.log('Today: ' + snapshot.today + ' | Tomorrow: ' + snapshot.tomorrow);
  Logger.log('--- Check-in Today (' + snapshot.counts.checkInToday + ') ---');
  for (var i = 0; i < snapshot.checkInToday.length; i++) {
    Logger.log('  ' + snapshot.checkInToday[i].dogName + ' [' + snapshot.checkInToday[i].type + ']');
  }
  Logger.log('--- Check-out Today (' + snapshot.counts.checkOutToday + ') ---');
  for (var i = 0; i < snapshot.checkOutToday.length; i++) {
    Logger.log('  ' + snapshot.checkOutToday[i].dogName + ' [' + snapshot.checkOutToday[i].type + ']');
  }
  Logger.log('--- Check-in Tomorrow (' + snapshot.counts.checkInTomorrow + ') ---');
  for (var i = 0; i < snapshot.checkInTomorrow.length; i++) {
    Logger.log('  ' + snapshot.checkInTomorrow[i].dogName + ' [' + snapshot.checkInTomorrow[i].type + ']');
  }
  Logger.log('--- Check-out Tomorrow (' + snapshot.counts.checkOutTomorrow + ') ---');
  for (var i = 0; i < snapshot.checkOutTomorrow.length; i++) {
    Logger.log('  ' + snapshot.checkOutTomorrow[i].dogName + ' [' + snapshot.checkOutTomorrow[i].type + ']');
  }
}

/**
 * Counts this account's refreshCheckInOutSnapshot triggers (triggers owned
 * by other Google accounts are invisible). -1 when the API is unavailable.
 */
function countCheckInOutTriggers_() {
  try {
    var triggers = ScriptApp.getProjectTriggers();
    var n = 0;
    for (var i = 0; i < triggers.length; i++) {
      if (triggers[i].getHandlerFunction() === CHECKINOUT_TRIGGER_HANDLER) n++;
    }
    return n;
  } catch (e) {
    return -1;
  }
}

/**
 * READ-ONLY inspector — run from the Apps Script editor to see exactly what
 * ?mode=checkinout would serve RIGHT NOW. Zero Acuity calls, zero writes:
 * logs the stored snapshot record (age, stay count), the boarding-cache
 * peek state, the failure/install stamps, which source a request would use,
 * and the buckets it would produce. Use testCheckInOutRefresh() when you
 * WANT to fetch fresh data and overwrite the snapshot.
 */
function inspectCheckInOutSnapshot() {
  var props = PropertiesService.getScriptProperties();

  var stored = readStoredCheckInOutSnapshot_();
  if (stored) {
    var age = snapshotAgeMs_(stored);
    Logger.log('[inspect] stored snapshot: ' + stored.stays.length +
               ' stays, fetched at ' + stored.fetchedAt + ' (' +
               (isNaN(age) ? 'unknown age' : Math.round(age / 60000) + ' min ago') + ')');
  } else {
    Logger.log('[inspect] no usable stored snapshot (missing, legacy-shaped, or corrupt)');
    var rawStored = props.getProperty(CHECKINOUT_SNAPSHOT_KEY);
    if (rawStored) {
      Logger.log('[inspect] raw property value (first 300 chars): ' + rawStored.substring(0, 300));
    }
  }

  var peeked = peekBoardingCache_();
  Logger.log('[inspect] boarding response cache: ' + (peeked
    ? (peeked.stays.length + ' stays, computed at ' + peeked.lastUpdated)
    : 'cold (no entry)'));

  Logger.log('[inspect] last failed refresh: ' +
             (props.getProperty(CHECKINOUT_FAIL_AT_KEY) || 'none'));
  Logger.log('[inspect] trigger install stamp: ' +
             (props.getProperty(CHECKINOUT_INSTALL_STAMP_KEY) || 'none') +
             ' | triggers visible to THIS account: ' + countCheckInOutTriggers_());

  var source = null;
  if (peekIsNewer_(peeked, stored)) {
    source = makeSnapshotRecord_(peeked);
    Logger.log('[inspect] a request now would ADOPT the fresher boarding cache (zero Acuity)');
  } else if (stored) {
    source = stored;
    Logger.log('[inspect] a request now would serve the stored snapshot');
  } else {
    Logger.log('[inspect] a request now would attempt a self-heal refresh (through the boarding response cache)');
  }

  if (source) {
    var payload = servePayloadFromStored_(source);
    Logger.log('[inspect] buckets for today ' + payload.today + ' / tomorrow ' +
               payload.tomorrow + ': inToday=' + payload.counts.checkInToday +
               ' outToday=' + payload.counts.checkOutToday +
               ' inTomorrow=' + payload.counts.checkInTomorrow +
               ' outTomorrow=' + payload.counts.checkOutTomorrow);
  }
}
