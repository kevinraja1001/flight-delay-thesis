const _ = require('lodash');
const Bluebird = require('bluebird');
const fs = require('fs');
const dayjs = require('dayjs');
const { parse } = require('csv-parse');

const aeroApi4Helpers = require('./helpers/aero_api4');

const AIRPORT_COUNT = 10;

const focusedDay = dayjs()
    .tz('Australia/Sydney')
    .subtract(1, 'day')
    .startOf('day');

Bluebird
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

        // const airlineDataParser = fs
        //     .createReadStream('./datasets/top-australian-airlines.csv')
        //     .pipe(parse({
        //         columns: true,
        //         skip_empty_lines: true,
        //         trim: true,
        //         relax_column_count: true,
        //     }));

        // const airlines = [];
        // for await (const record of airlineDataParser) {
        //     airlines.push(record);
        // };

        const flightsCsvSeed = [];
        const idxByColumnKey = {};

        await Bluebird.map(airports, async (airport) => {
            if (Number(airport.Rank) > AIRPORT_COUNT) {
                return Bluebird.resolve();
            }

            const queryParams = {
                start: focusedDay
                    .clone()
                    .startOf('day')
                    .toISOString(),
                end: focusedDay
                    .clone()
                    .add(1, 'day')
                    .startOf('day')
                    .toISOString(),
                max_pages: 10,
            };

            const flightsFromAirport = await aeroApi4Helpers.getFlightsDepartedFromAirport(airport.ICAO, queryParams);

            /**
             * Convert a flight object into an array of values
             * @author Jeremia Siahaan
             * @param {Object} flight 
             * @returns {Array<String|Number|Boolean>}
             */
            const makeCsvSeed = (flight) => {
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

                        if (!idxByColumnKey[columnKey]) {
                            (flightsCsvSeed[0] || (flightsCsvSeed[0] = [])).push(columnKey);
                            idx = flightsCsvSeed[0].length - 1;
                            idxByColumnKey[columnKey] = idx;
                        }

                        if (_.isArray(val)) {
                            flightCsvSeed[idx] = val.join(',');
                        } else {
                            flightCsvSeed[idx] = val;
                        }
                    });
                };

                insertValuesToCsvSeed(flight);

                return flightCsvSeed;
            };

            flightsCsvSeed.push(..._.map(flightsFromAirport, makeCsvSeed));
        }, { concurrency: 1 });

        const columnKeys = flightsCsvSeed[0];
        let csv = '';

        _.forEach(flightsCsvSeed, (rowSeed) => {
            _.forEach(columnKeys, (colKey, idx) => {
                if (_.isNil(rowSeed[idx])) {
                    rowSeed[idx] = '';
                }
            });

            csv += `${rowSeed.join(';')}\n`;
        });

        console.log('Writing CSV file...');
        fs.writeFileSync('result.csv', csv);
        console.log('CSV file is created: result.csv!');
    })
    .catch((err) => {
        console.error(`Error when fetching flight data from AeroAPI4. Error: ${err.stack || err}`);
    });