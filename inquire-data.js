const _ = require('lodash');
const Bluebird = require('bluebird');
const fs = require('fs');
const dayjs = require('dayjs');
const { parse } = require('csv-parse');

const aeroApi4Helpers = require('./helpers/aero_api4');

const AIRPORT_COUNT = 10;

Bluebird
    .try(async () => {
        const airlineDataParser = fs
            .createReadStream('./datasets/top-australian-airlines.csv')
            .pipe(parse({
                columns: true,
                skip_empty_lines: true,
                trim: true,
                relax_column_count: true,
            }));

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

        const airlines = [];
        for await (const record of airlineDataParser) {
            airlines.push(record);
        };

        await Bluebird.map(airports, async (airport) => {
            if (Number(airport.Rank) > 1) {
                return Bluebird.resolve();
            }

            const focusedDay = dayjs()
                .tz('Australia/Sydney')
                .subtract(1, 'day');
            

            const queryParams = {
                start: focusedDay
                    .startOf('day')
                    .toISOString(),
                end: focusedDay
                    .clone()
                    .add(1, 'day')
                    .startOf('day')
                    .toISOString(),
                max_pages: 10,
            };

            const flights = await aeroApi4Helpers.getFlightsDepartedFromAirport(airport.ICAO, queryParams);

            console.log(`Total flights from ${airport.City} on ${focusedDay.format('YYYY-MM-DD')}: ${flights.length}!`);
            _.forEach(flights, (flight, idx) => {
                if (idx <= 2) {
                    console.log(JSON.stringify(flight, null, 2));
                }
            });
        }, { concurrency: 1 });


    })
    .catch((err) => {
        console.error(`Error when fetching flight data from AeroAPI4. Error: ${err.stack || err}`);
    });