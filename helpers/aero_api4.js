const _ = require('lodash');
const axios = require('axios');
const Bluebird = require('bluebird');
const dayjs = require('dayjs');

const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(timezone);

const {
    AERO_API_4_API_KEY,
    AERO_API_4_URL,
} = process.env;

const PAGES_LIMIT = 10;
const SECONDS_PER_PAGES_LIMIT = 60;

const LAST_ATTEMPT = {
    pages: 0,
    timestamp: null,
};

const formatDepartureFlights = departureFlights => _.map(departureFlights, depFlight => {
    const originTimezone = depFlight.origin?.timezone;
    const destinationTimezone = depFlight.destination?.timezone;

    return ({
        ...depFlight,
        scheduled_out_local: depFlight.scheduled_out && originTimezone
            ? dayjs(depFlight.scheduled_out)
                .tz(originTimezone)
                .format('YYYY-MM-DDTHH:mm:ssZ')
            : depFlight.scheduled_out,
        estimated_out_local: depFlight.estimated_out
            ? dayjs(depFlight.estimated_out)
                .tz(originTimezone)
                .format('YYYY-MM-DDTHH:mm:ssZ')
            : depFlight.estimated_out,
        actual_out_local: depFlight.actual_out
            ? dayjs(depFlight.actual_out)
                .tz(originTimezone)
                .format('YYYY-MM-DDTHH:mm:ssZ')
            : depFlight.actual_out,
        
        scheduled_off_local: depFlight.scheduled_off && originTimezone
            ? dayjs(depFlight.scheduled_off)
                .tz(originTimezone)
                .format('YYYY-MM-DDTHH:mm:ssZ')
            : depFlight.scheduled_off,
        estimated_off_local: depFlight.estimated_off
            ? dayjs(depFlight.estimated_off)
                .tz(originTimezone)
                .format('YYYY-MM-DDTHH:mm:ssZ')
            : depFlight.estimated_off,
        actual_off_local: depFlight.actual_off
            ? dayjs(depFlight.actual_off)
                .tz(originTimezone)
                .format('YYYY-MM-DDTHH:mm:ssZ')
            : depFlight.actual_off,
        
        scheduled_on_local: depFlight.scheduled_on && destinationTimezone
            ? dayjs(depFlight.scheduled_on)
                .tz(destinationTimezone)
                .format('YYYY-MM-DDTHH:mm:ssZ')
            : depFlight.scheduled_on,
        estimated_on_local: depFlight.estimated_on
            ? dayjs(depFlight.estimated_on)
                .tz(destinationTimezone)
                .format('YYYY-MM-DDTHH:mm:ssZ')
            : depFlight.estimated_on,
        actual_on_local: depFlight.actual_on
            ? dayjs(depFlight.actual_on)
                .tz(destinationTimezone)
                .format('YYYY-MM-DDTHH:mm:ssZ')
            : depFlight.actual_on,

        scheduled_in_local: depFlight.scheduled_in && destinationTimezone
            ? dayjs(depFlight.scheduled_in)
                .tz(destinationTimezone)
                .format('YYYY-MM-DDTHH:mm:ssZ')
            : depFlight.scheduled_in,
        estimated_in_local: depFlight.estimated_in
            ? dayjs(depFlight.estimated_in)
                .tz(destinationTimezone)
                .format('YYYY-MM-DDTHH:mm:ssZ')
            : depFlight.estimated_in,
        actual_in_local: depFlight.actual_in
            ? dayjs(depFlight.actual_in)
                .tz(destinationTimezone)
                .format('YYYY-MM-DDTHH:mm:ssZ')
            : depFlight.actual_in,
    });
});

/**
 * Send HTTP GET request to AeroAPI 4
 * @author Jeremia Siahaan
 * @param {string} urlPath 
 * @returns {Object}
 */
const sendRequest = (urlPath) => {
    const apiUrl = `${AERO_API_4_URL}${urlPath}`;
    console.log(`Sending HTTP GET request to ${apiUrl}...`);

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
 * @returns {Array<Object>}
 */
const getFlights = async (urlPath, queryParams = {}, flightsKeys = []) => {
    let pageCount = 0;

    if (queryParams.max_pages && queryParams.max_pages > PAGES_LIMIT) {
        queryParams.max_pages = PAGES_LIMIT;
    }

    const queryString = new URLSearchParams(queryParams).toString();
    let _urlPath = `${urlPath}?${queryString}`;

    const flights = [];
    let isNextLinkAvailable = true;

    while (isNextLinkAvailable) {
        if (LAST_ATTEMPT.pages + queryParams.max_pages > PAGES_LIMIT) {
            let waitTimeInSeconds = SECONDS_PER_PAGES_LIMIT;

            if (LAST_ATTEMPT.timestamp) {
                waitTimeInSeconds -= dayjs().diff(LAST_ATTEMPT.timestamp, 'second');
            }
            
            console.log(`Last attempt happened at ${LAST_ATTEMPT.timestamp}. Waiting for ${waitTimeInSeconds} seconds...`);
            await Bluebird.delay (waitTimeInSeconds * 1000);
            LAST_ATTEMPT.pages = 0;
        }

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
            console.log(errorMessage);
            isNextLinkAvailable = false;
        }

        if (response?.data) {
            const { data: responseData } = response;
            _.forEach(flightsKeys, (flightsKey) => {
                console.log(`Get ${responseData[flightsKey]?.length || 0} ${flightsKey} flights from path ${_urlPath}!`);
                flights.push(...formatDepartureFlights(responseData[flightsKey]));
            });
            

            LAST_ATTEMPT.pages += Number(responseData.num_pages);
            LAST_ATTEMPT.timestamp = dayjs().toISOString();

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

    return flights;
};

/**
 * Get flights that are departed from an airport
 * @author Jeremia Siahaan
 * @param {string} originAirportCode 
 * @param {Object} queryParams 
 * @returns {Array<Object>}
 */
const getFlightsDepartedFromAirport = (originAirportCode, queryParams) => getFlights(
    `/airports/${originAirportCode}/flights/departures?${queryString}`,
    queryParams,
    ['departures'],
);

/**
 * Get historical flights that were planned to depart from an airport
 * @author Jeremia Siahaan
 * @param {string} originAirportCode 
 * @param {Object} queryParams 
 * @returns {Array<Object>}
 */
const getHistoricalFlightsDepartedFromAirport = (originAirportCode, queryParams) => getFlights(
    `/history/airports/${originAirportCode}/flights/departures?${queryString}`,
    queryParams,
    ['departures'],
);

/**
 * Get all flights of an operator
 * @author Jeremia Siahaan
 * @param {string} airlineCode 
 * @param {Object} queryParams 
 * @returns {Array<Object>}
 */
const getOperatorFlights = (airlineCode, queryParams) => getFlights(
    `/operators/${airlineCode}/flights`,
    queryParams,
    ['scheduled', 'arrivals', 'enroute'],
);

/**
 * Get all arrived flights of an operator
 * @author Jeremia Siahaan
 * @param {string} airlineCode 
 * @param {Object} queryParams 
 * @returns {Array<Object>}
 */
const getOperatorArrivedFlights = (airlineCode, queryParams) => getFlights(
    `/operators/${airlineCode}/flights/arrivals`,
    queryParams,
    ['arrivals'],
);

/**
 * Get all en route flights of an operator
 * @author Jeremia Siahaan
 * @param {string} airlineCode 
 * @param {Object} queryParams 
 * @returns {Array<Object>}
 */
const getOperatorEnRouteFlights = (airlineCode, queryParams) => getFlights(
    `/operators/${airlineCode}/flights/enroute`,
    queryParams,
    ['enroute'],
);

/**
 * Get all scheduled flights of an operator
 * @author Jeremia Siahaan
 * @param {string} airlineCode 
 * @param {Object} queryParams 
 * @returns {Array<Object>}
 */
const getOperatorScheduledFlights = (airlineCode, queryParams) => getFlights(
    `/operators/${airlineCode}/flights/scheduled`,
    queryParams,
    ['scheduled'],
);

/**
 * Get all historical flights of an operator
 * @author Jeremia Siahaan
 * @param {string} airlineCode 
 * @param {Object} queryParams 
 * @returns {Array<Object>}
 */
const getHistoricalOperatorFlights = (airlineCode, queryParams) => getFlights(
    `/history/operators/${airlineCode}/flights`,
    queryParams,
    ['flights'],
);

module.exports = {
    getFlightsDepartedFromAirport,
    getHistoricalFlightsDepartedFromAirport,
    getHistoricalOperatorFlights,
    getOperatorArrivedFlights,
    getOperatorEnRouteFlights,
    getOperatorFlights,
    getOperatorScheduledFlights,
};
