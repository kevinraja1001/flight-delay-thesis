const _ = require('lodash');
const axios = require('axios');
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
const MILLISECONDS_PER_PAGES_LIMIT = 60 * 1000;

const LAST_ATTEMPT = {
    pages: 0,
    timestamp: null,
};

/**
 * Format flights objects array
 * @author Jeremia Siahaan
 * @param {Object[]} flights 
 * @returns {Object[]}
 */
const formatFlights = flights => _.map(flights, flight => {
    const originTimezone = flight.origin?.timezone;
    const destinationTimezone = flight.destination?.timezone;

    return ({
        ...flight,
        scheduled_out_local: flight.scheduled_out && originTimezone
            ? dayjs(flight.scheduled_out)
                .tz(originTimezone)
                .format('YYYY-MM-DDTHH:mm:ssZ')
            : flight.scheduled_out,
        estimated_out_local: flight.estimated_out
            ? dayjs(flight.estimated_out)
                .tz(originTimezone)
                .format('YYYY-MM-DDTHH:mm:ssZ')
            : flight.estimated_out,
        actual_out_local: flight.actual_out
            ? dayjs(flight.actual_out)
                .tz(originTimezone)
                .format('YYYY-MM-DDTHH:mm:ssZ')
            : flight.actual_out,
        
        scheduled_off_local: flight.scheduled_off && originTimezone
            ? dayjs(flight.scheduled_off)
                .tz(originTimezone)
                .format('YYYY-MM-DDTHH:mm:ssZ')
            : flight.scheduled_off,
        estimated_off_local: flight.estimated_off
            ? dayjs(flight.estimated_off)
                .tz(originTimezone)
                .format('YYYY-MM-DDTHH:mm:ssZ')
            : flight.estimated_off,
        actual_off_local: flight.actual_off
            ? dayjs(flight.actual_off)
                .tz(originTimezone)
                .format('YYYY-MM-DDTHH:mm:ssZ')
            : flight.actual_off,
        
        scheduled_on_local: flight.scheduled_on && destinationTimezone
            ? dayjs(flight.scheduled_on)
                .tz(destinationTimezone)
                .format('YYYY-MM-DDTHH:mm:ssZ')
            : flight.scheduled_on,
        estimated_on_local: flight.estimated_on
            ? dayjs(flight.estimated_on)
                .tz(destinationTimezone)
                .format('YYYY-MM-DDTHH:mm:ssZ')
            : flight.estimated_on,
        actual_on_local: flight.actual_on
            ? dayjs(flight.actual_on)
                .tz(destinationTimezone)
                .format('YYYY-MM-DDTHH:mm:ssZ')
            : flight.actual_on,

        scheduled_in_local: flight.scheduled_in && destinationTimezone
            ? dayjs(flight.scheduled_in)
                .tz(destinationTimezone)
                .format('YYYY-MM-DDTHH:mm:ssZ')
            : flight.scheduled_in,
        estimated_in_local: flight.estimated_in
            ? dayjs(flight.estimated_in)
                .tz(destinationTimezone)
                .format('YYYY-MM-DDTHH:mm:ssZ')
            : flight.estimated_in,
        actual_in_local: flight.actual_in
            ? dayjs(flight.actual_in)
                .tz(destinationTimezone)
                .format('YYYY-MM-DDTHH:mm:ssZ')
            : flight.actual_in,
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
 * Delay for given milliseconds
 * @param {number} ms 
 * @returns {Promise}
 */
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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
            let waitTimeInMs = MILLISECONDS_PER_PAGES_LIMIT;

            if (LAST_ATTEMPT.timestamp) {
                waitTimeInMs -= new Date() - LAST_ATTEMPT.timestamp;
            }
            
            console.log(`Last attempt happened at ${LAST_ATTEMPT.timestamp}. Waiting for ${waitTimeInMs} ms...`);
            await delay(waitTimeInMs);
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
                flights.push(...formatFlights(responseData[flightsKey]));
            });
            

            LAST_ATTEMPT.pages += Number(responseData.num_pages);
            LAST_ATTEMPT.timestamp = new Date();

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
    `/airports/${originAirportCode}/flights/departures`,
    queryParams,
    ['departures'],
);

/**
 * Get flights that are departed from an airport
 * @author Jeremia Siahaan
 * @param {string} originAirportCode 
 * @param {Object} queryParams 
 * @returns {Array<Object>}
 */
const getFutureFlightsDepartingFromAirport = (originAirportCode, queryParams) => getFlights(
    `/airports/${originAirportCode}/flights/scheduled_departures`,
    queryParams,
    ['scheduled_departures'],
);

/**
 * Get historical flights that were planned to depart from an airport
 * @author Jeremia Siahaan
 * @param {string} originAirportCode 
 * @param {Object} queryParams 
 * @returns {Array<Object>}
 */
const getHistoricalFlightsDepartedFromAirport = (originAirportCode, queryParams) => getFlights(
    `/history/airports/${originAirportCode}/flights/departures`,
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
    getFutureFlightsDepartingFromAirport,
    getHistoricalFlightsDepartedFromAirport,
    getHistoricalOperatorFlights,
    getOperatorArrivedFlights,
    getOperatorEnRouteFlights,
    getOperatorFlights,
    getOperatorScheduledFlights,
};
