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

const formatDepartureFlights = departureFlights => _.map(departureFlights, dep => {
    const originTimezone = dep.origin?.timezone;
    const destinationTimezone = dep.destination?.timezone;

    return ({
        ...dep,
        scheduled_out_local: dep.scheduled_out && originTimezone
            ? dayjs(dep.scheduled_out)
                .tz(originTimezone)
                .format('YYYY-MM-DDTHH:mm:ssZ')
            : dep.scheduled_out,
        estimated_out_local: dep.estimated_out
            ? dayjs(dep.estimated_out)
                .tz(originTimezone)
                .format('YYYY-MM-DDTHH:mm:ssZ')
            : dep.estimated_out,
        actual_out_local: dep.actual_out
            ? dayjs(dep.actual_out)
                .tz(originTimezone)
                .format('YYYY-MM-DDTHH:mm:ssZ')
            : dep.actual_out,
        
        scheduled_off_local: dep.scheduled_off && originTimezone
            ? dayjs(dep.scheduled_off)
                .tz(originTimezone)
                .format('YYYY-MM-DDTHH:mm:ssZ')
            : dep.scheduled_off,
        estimated_off_local: dep.estimated_off
            ? dayjs(dep.estimated_off)
                .tz(originTimezone)
                .format('YYYY-MM-DDTHH:mm:ssZ')
            : dep.estimated_off,
        actual_off_local: dep.actual_off
            ? dayjs(dep.actual_off)
                .tz(originTimezone)
                .format('YYYY-MM-DDTHH:mm:ssZ')
            : dep.actual_off,
        
        scheduled_on_local: dep.scheduled_on && destinationTimezone
            ? dayjs(dep.scheduled_on)
                .tz(destinationTimezone)
                .format('YYYY-MM-DDTHH:mm:ssZ')
            : dep.scheduled_on,
        estimated_on_local: dep.estimated_on
            ? dayjs(dep.estimated_on)
                .tz(destinationTimezone)
                .format('YYYY-MM-DDTHH:mm:ssZ')
            : dep.estimated_on,
        actual_on_local: dep.actual_on
            ? dayjs(dep.actual_on)
                .tz(destinationTimezone)
                .format('YYYY-MM-DDTHH:mm:ssZ')
            : dep.actual_on,

        scheduled_in_local: dep.scheduled_in && destinationTimezone
            ? dayjs(dep.scheduled_in)
                .tz(destinationTimezone)
                .format('YYYY-MM-DDTHH:mm:ssZ')
            : dep.scheduled_in,
        estimated_in_local: dep.estimated_in
            ? dayjs(dep.estimated_in)
                .tz(destinationTimezone)
                .format('YYYY-MM-DDTHH:mm:ssZ')
            : dep.estimated_in,
        actual_in_local: dep.actual_in
            ? dayjs(dep.actual_in)
                .tz(destinationTimezone)
                .format('YYYY-MM-DDTHH:mm:ssZ')
            : dep.actual_in,
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
 * Get flights that are departed from an airport
 * @author Jeremia Siahaan
 * @param {string} originAirportCode 
 * @param {Object} queryParams 
 * @returns {Array<Object>}
 */
const getFlightsDepartedFromAirport = async (originAirportCode, queryParams) => {
    let pageCount = 0;

    if (queryParams.max_pages && queryParams.max_pages > PAGES_LIMIT) {
        queryParams.max_pages = PAGES_LIMIT;
    }

    const queryString = new URLSearchParams(queryParams).toString();
    let urlPath = `/airports/${originAirportCode}/flights/departures?${queryString}`;

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
            response = await sendRequest(urlPath);
        } catch (err) {
            let errorMessage = `Error from AeroAPI4 when sending request to ${urlPath} with query: ${JSON.stringify(queryParams)}.`;

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
            console.log(`Get ${responseData.departures.length} flights from path ${urlPath}!`);
            flights.push(...formatDepartureFlights(responseData.departures));

            LAST_ATTEMPT.pages += Number(responseData.num_pages);
            LAST_ATTEMPT.timestamp = dayjs().toISOString();

            if (responseData.links?.next) {
                urlPath = responseData.links.next;
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
 * Get historical flights that were planned to depart from an airport
 * @author Jeremia Siahaan
 * @param {string} originAirportCode 
 * @param {Object} queryParams 
 * @returns {Array<Object>}
 */
const getHistoricalFlightsDepartedFromAirport = async (originAirportCode, queryParams) => {
    const queryString = new URLSearchParams(queryParams).toString();
    let urlPath = `/history/airports/${originAirportCode}/flights/departures?${queryString}`;

    const flights = [];
    let isNextLinkAvailable = true;

    while (isNextLinkAvailable) {
        let response;

        try {
            response = await sendRequest(urlPath);
        } catch (err) {
            let errorMessage = `Error from AeroAPI4 when sending request to ${urlPath} with query: ${JSON.stringify(queryParams)}.`;

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
            console.log(`Get ${responseData.departures.length} flights from path ${urlPath}!`);
            flights.push(...formatDepartureFlights(responseData.departures));

            if (responseData.links?.next) {
                urlPath = responseData.links.next;
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

module.exports = {
    getFlightsDepartedFromAirport,
    getHistoricalFlightsDepartedFromAirport,
};
