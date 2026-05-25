const _ = require('lodash');
const fs = require('fs');
const dayjs = require('dayjs');
const { parse } = require('csv-parse');

const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(timezone);

const aeroApi4Helpers = require('./helpers/aero_api4');

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
const IDX_BY_COLUMN_KEY = {};
let CSV_TEXT = '';

/**
 * Create a CSV text generator from a flight object
 * @author Jeremia Siahaan
 * @param {boolean} shouldReturnHeader
 * @returns {Function}
 */
const createCsvTextGenerator = (shouldReturnHeader = false) => (flight) => {
    const flightCsvSeed = [];

    /**
     * Insert values from the flight object into CSV seed
     * @author Jeremia Siahaan
     * @param {*} flightObj 
     * @param {[String|Number]} parentKey 
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

            if (shouldMakeHeader) {
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

/**
 * Convert all flight objects into CSV text and push them into collective CSV text
 * @author Jeremia Siahaan
 * @param {Object[]} flights 
 * @param {boolean} shouldPrintHeader
 * @returns {void}
 */
const pushFlightsToCsvText = (flights, shouldPrintHeader) => {
    const generateCsv = createCsvTextGenerator(false);

    _.forEach(flights, (flight, idx) => {
        let _generateCsv = shouldPrintHeader && idx === 0
            ? createCsvTextGenerator(true)
            : generateCsv;
        const csvText = _generateCsv(flight);
        console.log(csvText);
        // TODO: uncomment if we want to collect all CSV texts
        // CSV_TEXT += `${csvText}\n`;
    });
};

Promise
    .try(async () => {
        console.log(`[${new Date().toISOString()}] Reading airports dataset...`);
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

        console.log(`[${new Date().toISOString()}] Reading airlines dataset...`);
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

            console.log(`[${new Date().toISOString()}] Fetching data for airport ${airport.ICAO} (IATA: ${airport.IATA}, city: ${airport.City})...`);

            const departureFlights = await aeroApi4Helpers.getFlightsDepartedFromAirport(
                airport.ICAO,
                {
                    ...queryParams,
                    type: 'Airline',
                },
            );
            pushFlightsToCsvText(departureFlights, airportIdx === 0);

            const scheduledDepartureFlights = await aeroApi4Helpers.getFutureFlightsDepartingFromAirport(
                airport.ICAO,
                {
                    ...queryParams,
                    type: 'Airline',
                },
            );
            pushFlightsToCsvText(scheduledDepartureFlights, false);
        }

        for await (const airline of airlines) {
            console.log(`[${new Date().toISOString()}] Fetching data for airline ${airline.ICAO} (IATA: ${airline.IATA}, name: ${airline.Name})...`);

            const arrivedFlights = await aeroApi4Helpers.getOperatorArrivedFlights(airline.ICAO, queryParams);
            pushFlightsToCsvText(arrivedFlights, false);

            const enRouteFlights = await aeroApi4Helpers.getOperatorEnRouteFlights(airline.ICAO, queryParams);
            pushFlightsToCsvText(enRouteFlights, false);

            const scheduledFlights = await aeroApi4Helpers.getOperatorScheduledFlights(airline.ICAO, queryParams);
            pushFlightsToCsvText(scheduledFlights, false);
        }
    })
    .then(() => {
        console.log(`[${new Date().toISOString()}] Done fetching all flights data!`);
    })
    .catch((err) => {
        console.error(`[${new Date().toISOString()}] Error when fetching flight data from AeroAPI4. Error: ${err.stack || err}`);
    })
    .finally(() => {
        console.log(`[${new Date().toISOString()}] End of process!`);
    });
