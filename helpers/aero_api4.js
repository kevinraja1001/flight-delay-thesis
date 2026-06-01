const _ = require('lodash');
const axios = require('axios');
const dayjs = require('dayjs');
const timezone = require('dayjs/plugin/timezone');
const utc = require('dayjs/plugin/utc');

const { log } = require('../utils');
const { RESULTS_SHAPES } = require('../constants');

dayjs.extend(utc);
dayjs.extend(timezone);

const {
    AERO_API_4_API_KEY,
    AERO_API_4_URL,
} = process.env;

const PAGES_LIMIT = 10;
const MILLISECONDS_PER_PAGES_LIMIT = 60 * 1000;
let IDX_BY_COLUMN_KEY = {};
let EXPECTED_RESULTS_SHAPE = RESULTS_SHAPES.objectArray;
let SHOULD_PRINT_RESULT_ON_LOG = false;
let CSV_TEXT = '';

/**
 * Delay for given milliseconds
 * @param {number} ms 
 * @returns {Promise}
 */
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * @author Jeremia Siahaan
 * @constructor
 */
function AttemptsHistory() {
    const history = [];

    const create = numOfPages => ({
        retrievedPages: Number(numOfPages),
        timestamp: new Date(),
    });

    const update = () => {
        let histIdx = 0;

        while (history.length > 0 && histIdx < history.length) {
            const attemptHist = history[histIdx];

            if (new Date() - attemptHist.timestamp > MILLISECONDS_PER_PAGES_LIMIT) {
                history.shift();
            } else {
                break;
            }
        }
    };

    const getLast = () => {
        update();

        let totalRetrievedPages = 0;
        let timestamp = null;

        _.forEach(history, (attemptHist, idx) => {
            totalRetrievedPages += attemptHist.retrievedPages;

            if (idx >= history.length - 1) {
                timestamp = attemptHist.timestamp;
            }
        });

        return ({
            timestamp,
            totalRetrievedPages,
        });
    };

    const delayForRateLimit = async (maxPages) => {
        const {
            timestamp: lastAttemptTimestamp,
            totalRetrievedPages,
        } = getLast();

        // Delay if the previously retrieved pages + queried max pages > pages limit
        if (totalRetrievedPages + maxPages > PAGES_LIMIT) {
            let waitTimeInMs = MILLISECONDS_PER_PAGES_LIMIT;

            if (lastAttemptTimestamp) {
                waitTimeInMs -= (new Date() - lastAttemptTimestamp);
                log(`Last attempt happened at ${lastAttemptTimestamp.toISOString()}. Waiting for ${waitTimeInMs} ms...`);
            } else {
                log(`Waiting for ${waitTimeInMs} ms...`);
            }

            await delay(waitTimeInMs);

            // Empty the attempts history
            update();
        }
    };

    const store = (numOfPages) => {
        update();
        history.push(create(numOfPages));
    };

    return {
        create,
        delayForRateLimit,
        getLast,
        store,
        update,
    };
};

const ATTEMPTS_HISTORY = new AttemptsHistory();

/**
 * @author Jeremia Siahaan
 * @constructor
 */
function FlightsResults() {
    let results;

    switch (EXPECTED_RESULTS_SHAPE) {
        case RESULTS_SHAPES.csv: {
            results = '';
            break;
        }
        default: {
            results = [];
        }
    }

    const push = (newResults) => {
        switch (EXPECTED_RESULTS_SHAPE) {
            case RESULTS_SHAPES.csv: {
                results += `${newResults}\n`;
                break;
            }
            default: {
                const _newResults = _.isArray(newResults)
                    ? newResults
                    : [newResults];

                results.push(..._newResults);
            }
        }
    };

    const value = () => results;

    const log = () => {
        switch (EXPECTED_RESULTS_SHAPE) {
            case RESULTS_SHAPES.objectArray: {
                console.log(JSON.stringify(results));
                break;
            }
            default: {
                console.log(results);
            }
        }
    };

    return {
        log,
        push,
        value,
    };
};

function FlightResult(flight, shouldReturnHeader = false) {
    const originTimezone = flight.origin?.timezone;
    const destinationTimezone = flight.destination?.timezone;

    let standardizedFlight = {
        ...flight,
        scheduled_out_local: flight.scheduled_out && originTimezone
            ? dayjs(flight.scheduled_out)
                .tz(originTimezone)
                .format('YYYY-MM-DDTHH:mm:ssZ')
            : flight.scheduled_out,
        estimated_out_local: flight.estimated_out && originTimezone
            ? dayjs(flight.estimated_out)
                .tz(originTimezone)
                .format('YYYY-MM-DDTHH:mm:ssZ')
            : flight.estimated_out,
        actual_out_local: flight.actual_out && originTimezone
            ? dayjs(flight.actual_out)
                .tz(originTimezone)
                .format('YYYY-MM-DDTHH:mm:ssZ')
            : flight.actual_out,
        
        scheduled_off_local: flight.scheduled_off && originTimezone
            ? dayjs(flight.scheduled_off)
                .tz(originTimezone)
                .format('YYYY-MM-DDTHH:mm:ssZ')
            : flight.scheduled_off,
        estimated_off_local: flight.estimated_off && originTimezone
            ? dayjs(flight.estimated_off)
                .tz(originTimezone)
                .format('YYYY-MM-DDTHH:mm:ssZ')
            : flight.estimated_off,
        actual_off_local: flight.actual_off && originTimezone
            ? dayjs(flight.actual_off)
                .tz(originTimezone)
                .format('YYYY-MM-DDTHH:mm:ssZ')
            : flight.actual_off,
        
        scheduled_on_local: flight.scheduled_on && destinationTimezone
            ? dayjs(flight.scheduled_on)
                .tz(destinationTimezone)
                .format('YYYY-MM-DDTHH:mm:ssZ')
            : flight.scheduled_on,
        estimated_on_local: flight.estimated_on && destinationTimezone
            ? dayjs(flight.estimated_on)
                .tz(destinationTimezone)
                .format('YYYY-MM-DDTHH:mm:ssZ')
            : flight.estimated_on,
        actual_on_local: flight.actual_on && destinationTimezone
            ? dayjs(flight.actual_on)
                .tz(destinationTimezone)
                .format('YYYY-MM-DDTHH:mm:ssZ')
            : flight.actual_on,

        scheduled_in_local: flight.scheduled_in && destinationTimezone
            ? dayjs(flight.scheduled_in)
                .tz(destinationTimezone)
                .format('YYYY-MM-DDTHH:mm:ssZ')
            : flight.scheduled_in,
        estimated_in_local: flight.estimated_in && destinationTimezone
            ? dayjs(flight.estimated_in)
                .tz(destinationTimezone)
                .format('YYYY-MM-DDTHH:mm:ssZ')
            : flight.estimated_in,
        actual_in_local: flight.actual_in && destinationTimezone
            ? dayjs(flight.actual_in)
                .tz(destinationTimezone)
                .format('YYYY-MM-DDTHH:mm:ssZ')
            : flight.actual_in,
    };

    /**
     * Generate CSV text from a flight object
     * @author Jeremia Siahaan
     * @param {Object} flight
     * @returns {string}
     */
    const generateCsv = (flight) => {
        if (shouldReturnHeader) {
            IDX_BY_COLUMN_KEY = {};
        }

        const flightCsvSeed = [];

        /**
         * Insert values from the flight object into CSV seed
         * @author Jeremia Siahaan
         * @param {Object} flightObj 
         * @param {[string|Number]} parentKey 
         */
        const insertValuesToCsvSeed = (flightObj, parentKey) => {
            _.forEach(flightObj, (val, key) => {
                if (_.isPlainObject(val) ||
                (_.isArray(val) && _.some(val, v => _.isPlainObject(v) || _.isArray(v)))) {
                    return insertValuesToCsvSeed(val, key);
                }

                const columnKey = parentKey
                    ? `${parentKey}_${key}`
                    : key;

                let idx = IDX_BY_COLUMN_KEY[columnKey];

                if (shouldReturnHeader) {
                    idx = _.size(IDX_BY_COLUMN_KEY);
                    IDX_BY_COLUMN_KEY[columnKey] = idx;
                }

                let _val = val;

                if (_.isArray(val)) {
                    _val = val.join(',');
                }

                if (_.isNumber(idx)) {
                    flightCsvSeed[idx] = _val;
                } else {
                    idx = _.size(IDX_BY_COLUMN_KEY);
                    (flightCsvSeed[idx] || (flightCsvSeed[idx] = {}))[columnKey] = _val;
                }
            });
        };

        insertValuesToCsvSeed(flight);

        const headerKeys = _.chain(IDX_BY_COLUMN_KEY)
            .keys()
            .sortBy(key => IDX_BY_COLUMN_KEY[key])
            .value();

        _.forEach(_.range(headerKeys.length + 1), (idx) => {
            const val = flightCsvSeed[idx];

            if (_.isNil(val)) {
                flightCsvSeed[idx] = '';
            } else if (_.isPlainObject(val)) {
                flightCsvSeed[idx] = `"${JSON.stringify(val).replace(/"/g, '""')}"`;
            }
        });

        const csvRows = [];

        if (shouldReturnHeader) {
            csvRows.push(`${headerKeys.join(';')};other_properties`);
        }
        csvRows.push(flightCsvSeed.join(';'));
        
        return csvRows.join('\n');
    };

    if (EXPECTED_RESULTS_SHAPE === RESULTS_SHAPES.csv) {
        standardizedFlight = generateCsv(standardizedFlight);
    }
    
    return { value: () => standardizedFlight };
};

/**
 * Send HTTP GET request to AeroAPI 4
 * @author Jeremia Siahaan
 * @param {string} urlPath 
 * @returns {Promise<Axios>}
 */
const sendRequest = (urlPath) => {
    const apiUrl = `${AERO_API_4_URL}${urlPath}`;
    log(`Sending HTTP GET request to ${apiUrl}...`);

    return axios({
        headers: { 'x-apikey': AERO_API_4_API_KEY },
        method: 'get',
        url: apiUrl,
    });
};

/**
 * Get flights from AeroAPI
 * @author Jeremia Siahaan
 * @param {string} urlPath 
 * @param {Object} [queryParams]
 * @param {string[]} [flightsKeys] 
 * @param {Object} [opts]
 * @returns {Promise<Object[]|string>}
 */
const getFlights = async (
    urlPath,
    queryParams = {},
    flightsKeys = [],
    opts = {},
) => {
    let pageCount = 0;

    if (queryParams.max_pages && queryParams.max_pages > PAGES_LIMIT) {
        queryParams.max_pages = PAGES_LIMIT;
    }

    const queryString = new URLSearchParams(queryParams).toString();
    let _urlPath = `${urlPath}?${queryString}`;

    const flights = new FlightsResults();

    let isNextLinkAvailable = true;
    let shouldRetry = false;
    let iterationIdx = 0;
    let shouldReturnHeader = opts?.shouldReturnHeader || false;

    while (isNextLinkAvailable || shouldRetry) {
        await ATTEMPTS_HISTORY.delayForRateLimit(queryParams.max_pages);

        let response;

        try {
            response = await sendRequest(_urlPath);
        } catch (err) {
            let errorMessage = `Error from AeroAPI4 when sending request to ${_urlPath} with query: ${JSON.stringify(queryParams)}.`;

            if (err.response) {
                // The request was made and the server responded with a status code
                // that falls out of the range of 2xx
                errorMessage += ` Response: ${JSON.stringify(err.response.data)}, status: ${err.response.status}, headers: ${err.response.headers}.`;
            } else if (err.request) {
                // The request was made but no response was received
                // `error.request` is an instance of XMLHttpRequest in the browser and an instance of
                // http.ClientRequest in node.js
                errorMessage += ` Request: ${JSON.stringify(err.request)}.`;
            } else {
                // Something happened in setting up the request that triggered an Error
                errorMessage += ` Error: ${err.message}.`;
            }

            errorMessage += ` Config: ${JSON.stringify(err.config)}.`;
            log(errorMessage);
            isNextLinkAvailable = false;

            if (err.response?.status === 429) {
                shouldRetry = true;
                ATTEMPTS_HISTORY.store(PAGES_LIMIT);
            } else {
                shouldRetry = false;
            }
        }

        if (response?.data) {
            shouldRetry = false;
            const { data: responseData } = response;
            ATTEMPTS_HISTORY.store(responseData.num_pages);

            const thisIterationFlights = new FlightsResults();

            _.forEach(flightsKeys, (flightsKey, keyIdx) => {
                log(`Got ${responseData[flightsKey]?.length || 0} ${_.lowerCase(flightsKey)} flights from path ${_urlPath}!`);
                _.forEach(responseData[flightsKey], (flight, flightIdx) => {
                    try {
                        const flightRes = new FlightResult(flight, shouldReturnHeader);

                        thisIterationFlights.push(flightRes.value());
                        shouldReturnHeader = false;
                    } catch (err) {
                        log(`Error when standardizing object ${JSON.stringify(flight)}. Error: ${err.stack || JSON.stringify(err)}`);
                    }
                });
            });

            if (SHOULD_PRINT_RESULT_ON_LOG) {
                thisIterationFlights.log();
            }

            flights.push(thisIterationFlights.value());
            iterationIdx++;

            if (responseData.links?.next) {
                _urlPath = responseData.links.next;
                isNextLinkAvailable = true;
            } else {
                isNextLinkAvailable = false;
            }
        } else {
            isNextLinkAvailable = false;
        }
    }

    return flights.value();
};

/**
 * Get flights that are departed from an airport
 * @author Jeremia Siahaan
 * @param {string} originAirportCode 
 * @param {Object} [queryParams]
 * @param {Object} [opts]
 * @returns {Promise<Object[]|string>}
 */
const getFlightsDepartedFromAirport = (originAirportCode, queryParams = {}, opts = {}) => getFlights(
    `/airports/${originAirportCode}/flights/departures`,
    queryParams,
    ['departures'],
    opts,
);

/**
 * Get flights that are departed from an airport
 * @author Jeremia Siahaan
 * @param {string} originAirportCode 
 * @param {Object} [queryParams]
 * @param {Object} [opts]
 * @returns {Promise<Object[]|string>}
 */
const getFutureFlightsDepartingFromAirport = (originAirportCode, queryParams = {}, opts = {}) => getFlights(
    `/airports/${originAirportCode}/flights/scheduled_departures`,
    queryParams,
    ['scheduled_departures'],
    opts,
);

/**
 * Get historical flights that were planned to depart from an airport
 * @author Jeremia Siahaan
 * @param {string} originAirportCode 
 * @param {Object} [queryParams]
 * @param {Object} [opts]
 * @returns {Promise<Object[]|string>}
 */
const getHistoricalFlightsDepartedFromAirport = (originAirportCode, queryParams = {}, opts = {}) => getFlights(
    `/history/airports/${originAirportCode}/flights/departures`,
    queryParams,
    ['departures'],
    opts,
);

/**
 * Get all flights of an operator
 * @author Jeremia Siahaan
 * @param {string} airlineCode 
 * @param {Object} [queryParams]
 * @param {Object} [opts]
 * @returns {Promise<Object[]|string>}
 */
const getOperatorFlights = (airlineCode, queryParams = {}, opts = {}) => getFlights(
    `/operators/${airlineCode}/flights`,
    queryParams,
    ['scheduled', 'arrivals', 'enroute'],
    opts,
);

/**
 * Get all arrived flights of an operator
 * @author Jeremia Siahaan
 * @param {string} airlineCode 
 * @param {Object} [queryParams]
 * @param {Object} [opts]
 * @returns {Promise<Object[]|string>}
 */
const getOperatorArrivedFlights = (airlineCode, queryParams = {}, opts = {}) => getFlights(
    `/operators/${airlineCode}/flights/arrivals`,
    queryParams,
    ['arrivals'],
    opts,
);

/**
 * Get all en route flights of an operator
 * @author Jeremia Siahaan
 * @param {string} airlineCode 
 * @param {Object} [queryParams]
 * @param {Object} [opts]
 * @returns {Promise<Object[]|string>}
 */
const getOperatorEnRouteFlights = (airlineCode, queryParams = {}, opts = {}) => getFlights(
    `/operators/${airlineCode}/flights/enroute`,
    queryParams,
    ['enroute'],
    opts,
);

/**
 * Get all scheduled flights of an operator
 * @author Jeremia Siahaan
 * @param {string} airlineCode 
 * @param {Object} [queryParams]
 * @param {Object} [opts]
 * @returns {Promise<Object[]|string>}
 */
const getOperatorScheduledFlights = (airlineCode, queryParams = {}, opts = {}) => getFlights(
    `/operators/${airlineCode}/flights/scheduled`,
    queryParams,
    ['scheduled'],
    opts,
);

/**
 * Get all historical flights of an operator
 * @author Jeremia Siahaan
 * @param {string} airlineCode 
 * @param {Object} [queryParams]
 * @param {Object} [opts]
 * @returns {Promise<Object[]|string>}
 */
const getHistoricalOperatorFlights = (airlineCode, queryParams = {}, opts = {}) => getFlights(
    `/history/operators/${airlineCode}/flights`,
    queryParams,
    ['flights'],
    opts,
);

module.exports = (
    expectedResultsShape = RESULTS_SHAPES.objectArray,
    shouldPrintResultOnLog = false,
) => {
    EXPECTED_RESULTS_SHAPE = expectedResultsShape;
    SHOULD_PRINT_RESULT_ON_LOG = shouldPrintResultOnLog;

    return ({
        getFlightsDepartedFromAirport,
        getFutureFlightsDepartingFromAirport,
        getHistoricalFlightsDepartedFromAirport,
        getHistoricalOperatorFlights,
        getOperatorArrivedFlights,
        getOperatorEnRouteFlights,
        getOperatorFlights,
        getOperatorScheduledFlights,
    });
};
