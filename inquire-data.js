const _ = require('lodash');
const Bluebird = require('bluebird');
const dayjs = require('dayjs');
const superagent = require('superagent');

const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(timezone);

const {
    AERO_API_4_API_KEY,
    AERO_API_4_URL,
} = process.env;

Bluebird
    .try(async () => {
        const airlineIcao = 'QFA';
        const startTime = '2026-05-04';
        const firstPath = `/airports/YSSY/flights/departures?airline=${airlineIcao}&start=${startTime}`;
        const apiUrl = `${AERO_API_4_URL}${firstPath}`;

        const response = await superagent
            .get(apiUrl)
            .set('x-apikey', AERO_API_4_API_KEY);

        const { body: responseBody } = response;

        const results = _.map(responseBody.departures, dep => {
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

        console.log(JSON.stringify(results, null, 2));
        console.log(`Next URL: ${AERO_API_4_URL}${responseBody.links?.next}`);

    })
    .catch((err) => {
        console.error(`Error when fetching flight data from AeroAPI4. Error: ${err.stack || err}`);
    });