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
const START_DATE = '2026-05-22';
const END_DATE = '2026-05-24';
const idxByColumnKey = {};

/**
 * Convert a flight object into an array of values
 * @author Jeremia Siahaan
 * @param {Object} flight
 * @param {boolean} shouldMakeHeader
 * @returns {Array<String|Number|Boolean>}
 */
const makeCsvSeed = (flight, shouldMakeHeader) => {
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

            let idx = idxByColumnKey[columnKey];

            if (shouldMakeHeader) {
                idx = _.size(idxByColumnKey);
                idxByColumnKey[columnKey] = idx;
            }

            let _val = val;

            if (_.isArray(val)) {
                _val = val.join(',');
            }

            if (_.isNumber(idx)) {
                flightCsvSeed[idx] = _val;
            } else {
                idx = _.size(idxByColumnKey);
                (flightCsvSeed[idx] || (flightCsvSeed[idx] = {}))[columnKey] = _val;
            }
        });
    };

    insertValuesToCsvSeed(flight);

    const headerKeys = _.chain(idxByColumnKey)
        .keys()
        .sortBy(key => idxByColumnKey[key])
        .value();

    if (shouldMakeHeader) {        
        console.log(`${headerKeys.join(';')};other_properties`);
    }

    _.forEach(_.range(headerKeys.length + 1), (idx) => {
        const val = flightCsvSeed[idx];

        if (_.isNil(val)) {
            flightCsvSeed[idx] = '';
        } else if (_.isPlainObject(val)) {
            flightCsvSeed[idx] = `"${JSON.stringify(val).replace(/"/g, '""')}"`;
        }
    });

    console.log(flightCsvSeed.join(';'));
};

Promise
    .try(async () => {
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
            start: dayjs
                .utc(START_DATE)
                .format(),
            end: dayjs
                .utc(END_DATE)
                .add(1, 'day')
                .format(),
            max_pages: 10,
        };

        for (const [airportIdx, airport] of airports.entries()) {
            if (Number(airport.Rank) > AIRPORT_COUNT) {
                return null;
            }
            console.log(`Fetching data for airport ${airport.ICAO} (IATA: ${airport.IATA}, city: ${airport.City})...`);


            const departureFlights = await aeroApi4Helpers.getFlightsDepartedFromAirport(
                airport.ICAO,
                {
                    ...queryParams,
                    type: 'Airline',
                },
            );
            _.forEach(departureFlights, (flight, idx) => {
                makeCsvSeed(flight, airportIdx === 0 && idx === 0);
            });

            const scheduledDepartureFlights = await aeroApi4Helpers.getFutureFlightsDepartingFromAirport(
                airport.ICAO,
                {
                    ...queryParams,
                    type: 'Airline',
                },
            );
            _.forEach(scheduledDepartureFlights, (flight) => {
                makeCsvSeed(flight, false);
            });
        }

        airlines.forEach(async (airline) => {
            console.log(`Fetching data for airline ${airline.ICAO} (IATA: ${airline.IATA}, name: ${airline.Name})...`);

            const arrivedFlights = await aeroApi4Helpers.getOperatorArrivedFlights(airline.ICAO, queryParams);
            _.forEach(arrivedFlights, (flight) => {
                makeCsvSeed(flight, false);
            });

            const enRouteFlights = await aeroApi4Helpers.getOperatorEnRouteFlights(airline.ICAO, queryParams);
            _.forEach(enRouteFlights, (flight) => {
                makeCsvSeed(flight, false);
            });

            const scheduledFlights = await aeroApi4Helpers.getOperatorScheduledFlights(airline.ICAO, queryParams);
            _.forEach(scheduledFlights, (flight) => {
                makeCsvSeed(flight, false);
            });
        });
    })
    .then(() => {
        console.log('Done fetching all flights data!');
    })
    .catch((err) => {
        console.error(`Error when fetching flight data from AeroAPI4. Error: ${err.stack || err}`);
    })
    .finally(() => {
        console.log(`End of process!`);
    });