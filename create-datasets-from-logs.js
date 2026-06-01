const _ = require('lodash');
const dayjs = require('dayjs');
const fs = require('fs');
const timezone = require('dayjs/plugin/timezone');
const utc = require('dayjs/plugin/utc');

dayjs.extend(utc);
dayjs.extend(timezone);

const CREATE_CSV_FOR_EXCEL_READABLE = true;

const separateCsv = (logFilePath) => {
    const logText = fs.readFileSync(logFilePath, { encoding: 'utf8' });
    const rows = logText.split('\n');
    let headers;
    const airportCollection = [];
    const airlineCollection = [];
    let collection;

    let rowIdx = 0;

    while (rows.length > 0 && rowIdx < rows.length) {
        const rowStr = rows[rowIdx];

        if (rowStr.indexOf('Fetching data for ') >= 0) {
            if (rowStr.indexOf('airport') >= 0) {
                collection = airportCollection;
            } else if (rowStr.indexOf('airline') >= 0) {
                collection = airlineCollection;
            }
            rows.shift();
        } else if (rowStr.indexOf('nohup') >= 0 || rowStr.indexOf('   at ') >= 0 || _.isEmpty(rowStr)) {
            rows.shift();
        } else if (rowStr.indexOf('Error when standardizing object') >= 0) {
            const responseJson = rowStr.match(/\{.*\}/s)[0];
            const response = JSON.parse(responseJson);

            const rowObj = {};

            const insertValuesToCsvSeed = (flightObj, parentKey) => {
                _.forEach(flightObj, (val, key) => {
                    if (_.isPlainObject(val) ||
                    (_.isArray(val) && _.some(val, v => _.isPlainObject(v) || _.isArray(v)))) {
                        return insertValuesToCsvSeed(val, key);
                    }

                    const columnKey = parentKey
                        ? `${parentKey}_${key}`
                        : key;

                    let _val = val;

                    if (_.isArray(val)) {
                        _val = val.join(',');
                    }

                    if (_.indexOf(headers, columnKey) >= 0) {
                        rowObj[columnKey] = _val;
                    } else {
                        (rowObj.other_properties || (rowObj.other_properties = {}))[columnKey] = _val;
                    }
                });
            };

            insertValuesToCsvSeed(response);
            collection.push(rowObj);

            rowIdx++;
        } else if (rowStr.match(/\[.*\]/s) || rowStr.indexOf(';') < 0) {
            rows.shift();
        } else {
            const rowValues = rowStr.split(';');

            if (_.isEmpty(headers)) {
                headers = rowValues;
            } else {
                const rowObj = {};
                
                _.forEach(headers, (header, idx) => {
                    rowObj[header] = rowValues[idx];
                });

                collection.push(rowObj);
            }

            rowIdx++;
        }
    }

    const keyedResults = {
        ..._.groupBy(airportCollection, (res) => {
            const date = dayjs(res.scheduled_off || res.scheduled_out)
                .tz(res.origin_timezone)
                .format('YYYYMMDD');

            return `${res.origin_code_icao}_${date}`;
        }),
        ..._.groupBy(airlineCollection, (res) => {
            const date = dayjs(res.scheduled_off || res.scheduled_out)
                .tz(res.origin_timezone)
                .format('YYYYMMDD');

            return `${res.operator_icao}_${date}`;
        }),
    };
    _.forOwn(keyedResults, (results, groupKey) => {
        const sortedResults = _.sortBy(results, res => dayjs(res.scheduled_off || res.scheduled_out).valueOf());
        const csvRows = [headers.join(';')];
        _.forEach(results, (res) => {
            const rowSeed = [];
            _.forEach(headers, (header) => {
                rowSeed.push(res[header] || '');
            });

            csvRows.push(rowSeed.join(';'));
        });

        let csvText = CREATE_CSV_FOR_EXCEL_READABLE
            ? 'sep=;\n'
            : '';
        csvText += csvRows.join('\n');
        console.log(`${groupKey}: ${sortedResults.length}`);
        fs.writeFileSync(`./fetched-datasets${CREATE_CSV_FOR_EXCEL_READABLE ? '-excel' : ''}/${groupKey}.csv`, csvText);
    });
};

separateCsv('./20260526_0001.log');
separateCsv('./20260526_0002.log');
