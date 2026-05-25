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

const AIRPORT_COUNT = 10;
const START_DATE_TIME = dayjs
    .tz('2026-05-18 00:00:00', 'Australia/Perth')
    .startOf('day')
    .utc()
    .format();
const END_DATE_TIME = dayjs
    .tz('2026-05-24 23:59:59', 'Australia/Perth')
    .add(1, 'day')
    .startOf('day')
    .utc()
    .format();

Promise
    .try(async () => {
        log('Reading airports dataset...');
        const airportDataParser = fs
            .createReadStream('./datasets/top-20-busiest-australian-airports.csv')
            .pipe(parse({
                columns: true,
                skip_empty_lines: true,
                trim: true,
                relax_column_count: true,
            }));
        
        const airports = [];
        for await (const record of airportDataParser) {
            airports.push(record);
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

        const airlines = [];
        for await (const record of airlineDataParser) {
            airlines.push(record);
        };

        const queryParams = {
            start: START_DATE_TIME,
            end: END_DATE_TIME,
            max_pages: 5,
        };

        for await (const [airportIdx, airport] of airports.entries()) {
            if (Number(airport.Rank) > AIRPORT_COUNT) {
                return null;
            }

            log(`Fetching data for airport ${airport.ICAO} (IATA: ${airport.IATA}, city: ${airport.City})...`);
            const _queryParams = {
                ...queryParams,
                type: 'Airline',
            };

            const departureFlights = await aeroApi4Helpers.getFlightsDepartedFromAirport(
                airport.ICAO,
                _queryParams,
                { shouldReturnHeader: airportIdx === 0 },
            );

            const scheduledDepartureFlights = await aeroApi4Helpers.getFutureFlightsDepartingFromAirport(
                airport.ICAO,
                _queryParams,
            );
        }

        for await (const airline of airlines) {
            log(`Fetching data for airline ${airline.ICAO} (IATA: ${airline.IATA}, name: ${airline.Name})...`);

            const arrivedFlights = await aeroApi4Helpers.getOperatorArrivedFlights(airline.ICAO, queryParams);
            const enRouteFlights = await aeroApi4Helpers.getOperatorEnRouteFlights(airline.ICAO, queryParams);
            const scheduledFlights = await aeroApi4Helpers.getOperatorScheduledFlights(airline.ICAO, queryParams);
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
