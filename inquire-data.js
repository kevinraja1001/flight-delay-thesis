const _ = require('lodash');
const fs = require('fs');
const dayjs = require('dayjs');
const timezone = require('dayjs/plugin/timezone');
const utc = require('dayjs/plugin/utc');
const { parse } = require('csv-parse');

dayjs.extend(utc);
dayjs.extend(timezone);

const createAeroApi4Helpers = require('./helpers/aero_api4');
const { log } = require('./utils');
const { RESULTS_SHAPES } = require('./constants');

const aeroApi4Helpers = createAeroApi4Helpers(RESULTS_SHAPES.objectArray, true);

const DATA_TYPE = {
    airline: 'AIRLINE',
    airport: 'AIRPORT',
};

const AIRPORT_COUNT = 10;
const START_DATE_TIME = dayjs
    .tz('2025-06-01 00:00:00', 'Australia/Perth')
    .startOf('day')
    .utc()
    .format();
const END_DATE_TIME = dayjs
    .tz('2025-06-30 23:59:59', 'Australia/Perth')
    .add(1, 'day')
    .startOf('day')
    .utc()
    .format();
// const START_DATE_TIME = dayjs
//     .tz('2026-08-17 00:00:00', 'Australia/Perth')
//     .startOf('day')
//     .utc()
//     .format();
// const END_DATE_TIME = dayjs
//     .tz('2026-08-23 23:59:59', 'Australia/Perth')
//     .add(1, 'day')
//     .startOf('day')
//     .utc()
//     .format();
// const MAX_PAGES_PER_REQUEST = 10;
const MAX_PAGES_PER_REQUEST = 5;

Promise
    .try(async () => {
        const allRawData = [];
        /*log('Reading airports dataset...');
        const airportDataParser = fs
            .createReadStream('./datasets/top-20-busiest-australian-airports.csv')
            .pipe(parse({
                columns: true,
                skip_empty_lines: true,
                trim: true,
                relax_column_count: true,
            }));

        for await (const record of airportDataParser) {
            allRawData.push({
                ...record,
                type: DATA_TYPE.airport,
            });
        }*/

        log('Reading airlines dataset...');
        const airlineDataParser = fs
            .createReadStream('./datasets/top-australian-airlines.csv')
            .pipe(parse({
                columns: true,
                skip_empty_lines: true,
                trim: true,
                relax_column_count: true,
            }));

        for await (const record of airlineDataParser) {
            allRawData.push({
                ...record,
                type: DATA_TYPE.airline,
            });
        };
        
        // Create date ranges
        const dateRanges = [];

        let startDateTime = START_DATE_TIME;
        let endDateTime = START_DATE_TIME;
        
        while (dayjs(endDateTime).isBefore(END_DATE_TIME)) {
            if (dayjs().diff(startDateTime, 'hour') < 10 * 24) {
                endDateTime = dayjs(END_DATE_TIME).isSameOrBefore()
                    ? END_DATE_TIME
                    : dayjs().utc().format();
                dateRanges.push({
                    start: startDateTime,
                    end: endDateTime,
                    queryType: 'CURRENT',
                });
                startDateTime = endDateTime;
                endDateTime = dayjs(startDateTime)
                    .tz('Australia/Perth')
                    .add(7, 'day')
                    .startOf('day')
                    .utc()
                    .format();
            } else {
                endDateTime = dayjs(startDateTime)
                    .tz('Australia/Perth')
                    .add(1, 'day')
                    .startOf('day')
                    .utc()
                    .format();
                dateRanges.push({
                    start: startDateTime,
                    end: endDateTime,
                    queryType: 'HISTORICAL',
                });
                startDateTime = endDateTime;
                endDateTime = dayjs(startDateTime)
                    .tz('Australia/Perth')
                    .add(1, 'day')
                    .startOf('day')
                    .utc()
                    .format();
            }
        }

        const _allRawData = _.uniqBy(allRawData, 'ICAO');
        let shouldReturnHeader = true;

        for await (const [idx, rawData] of _allRawData.entries()) {
            if (rawData.type === DATA_TYPE.airport) {
                if (Number(rawData.Rank) > AIRPORT_COUNT) {
                    continue;
                }

                log(`Fetching data for airport ${rawData.ICAO} (IATA: ${rawData.IATA}, city: ${rawData.City})...`);
                for await (const dateRange of dateRanges) {
                    const queryParams = {
                        start: dateRange.start,
                        end: dateRange.end,
                        max_pages: MAX_PAGES_PER_REQUEST,
                        type: 'Airline',
                    }

                    if (dateRange.queryType === 'HISTORICAL') {
                        const historicalDepartureFlights = await aeroApi4Helpers.getHistoricalFlightsDepartedFromAirport(
                            rawData.ICAO,
                            queryParams,
                            { shouldReturnHeader },
                        );
                    } else if (dateRange.queryType === 'CURRENT') {
                        const departureFlights = await aeroApi4Helpers.getFlightsDepartedFromAirport(
                            rawData.ICAO,
                            _queryParams,
                            { shouldReturnHeader },
                        );

                        const scheduledDepartureFlights = await aeroApi4Helpers.getFutureFlightsDepartingFromAirport(
                            rawData.ICAO,
                            _queryParams,
                        );
                    }

                    shouldReturnHeader = false;
                }                
            } else if (rawData.type === DATA_TYPE.airline) {
                log(`Fetching data for airline ${rawData.ICAO} (IATA: ${rawData.IATA}, name: ${rawData.Name})...`);

                for await (const dateRange of dateRanges) {
                    const queryParams = {
                        start: dateRange.start,
                        end: dateRange.end,
                        max_pages: MAX_PAGES_PER_REQUEST,
                        type: 'Airline',
                    }

                    if (dateRange.queryType === 'HISTORICAL') {
                        const historicalFlights = await aeroApi4Helpers.getHistoricalOperatorFlights(
                            rawData.ICAO,
                            queryParams,
                            { shouldReturnHeader },
                        );
                        const historicalCancelledFlights = await aeroApi4Helpers.getHistoricalCancelledOperatorFlights(
                            rawData.ICAO,
                            queryParams,
                            { shouldReturnHeader },
                        );
                    } else if (dateRange.queryType === 'CURRENT') {
                        const arrivedFlights = await aeroApi4Helpers.getOperatorArrivedFlights(
                            rawData.ICAO,
                            queryParams,
                            { shouldReturnHeader },
                        );
                        const enRouteFlights = await aeroApi4Helpers.getOperatorEnRouteFlights(rawData.ICAO, queryParams);
                        const scheduledFlights = await aeroApi4Helpers.getOperatorScheduledFlights(rawData.ICAO, queryParams);
                    }

                    shouldReturnHeader = false;
                }
            }
        }
    })
    .then(() => {
        log('Done fetching all flights data!');
    })
    .catch((err) => {
        log(`Error when fetching flight data from AeroAPI4. Error: ${err.stack || err}`);
    })
    .finally(() => {
        log('End of process!');
    });
