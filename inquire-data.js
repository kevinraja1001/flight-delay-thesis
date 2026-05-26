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

const aeroApi4Helpers = createAeroApi4Helpers(RESULTS_SHAPES.csv, true);

const DATA_TYPE = {
    airline: 'AIRLINE',
    airport: 'AIRPORT',
};

const AIRPORT_COUNT = 10;
const START_DATE_TIME = dayjs
    .tz('2026-05-25 00:00:00', 'Australia/Perth')
    .startOf('day')
    .utc()
    .format();
const END_DATE_TIME = dayjs
    .tz('2026-05-25 23:59:59', 'Australia/Perth')
    .add(1, 'day')
    .startOf('day')
    .utc()
    .format();

Promise
    .try(async () => {
        const allRawData = [];
        log('Reading airports dataset...');
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
        }

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

        const queryParams = {
            start: START_DATE_TIME,
            end: END_DATE_TIME,
            max_pages: 5,
        };

        const _allRawData = _.uniqBy(allRawData, 'ICAO');
        for await (const [idx, rawData] of _allRawData.entries()) {
            if (rawData.type === DATA_TYPE.airport) {
                if (Number(rawData.Rank) > AIRPORT_COUNT) {
                    return null;
                }

                log(`Fetching data for airport ${rawData.ICAO} (IATA: ${rawData.IATA}, city: ${rawData.City})...`);
                const _queryParams = {
                    ...queryParams,
                    type: 'Airline',
                };

                const departureFlights = await aeroApi4Helpers.getFlightsDepartedFromAirport(
                    rawData.ICAO,
                    _queryParams,
                    { shouldReturnHeader: idx === 0 },
                );

                const scheduledDepartureFlights = await aeroApi4Helpers.getFutureFlightsDepartingFromAirport(
                    rawData.ICAO,
                    _queryParams,
                );
            } else if (rawData.type === DATA_TYPE.airline) {
                log(`Fetching data for airline ${rawData.ICAO} (IATA: ${rawData.IATA}, name: ${rawData.Name})...`);

                const arrivedFlights = await aeroApi4Helpers.getOperatorArrivedFlights(
                    rawData.ICAO,
                    queryParams,
                    { shouldReturnHeader: idx === 0 },
                );
                const enRouteFlights = await aeroApi4Helpers.getOperatorEnRouteFlights(rawData.ICAO, queryParams);
                const scheduledFlights = await aeroApi4Helpers.getOperatorScheduledFlights(rawData.ICAO, queryParams);
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
