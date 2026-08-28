#!/usr/bin/env node

const fs = require('fs');
const { parse } = require('csv-parse');

const TIME_ZONE = 'Australia/Perth';
const REQUIRED_COLUMNS = ['scheduled_out', 'scheduled_off'];
const MONTH_FORMATTER = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
});

function usage() {
    return [
        'Usage: node count-schedules-by-month.js [CSV_FILE ...]',
        '',
        'With no arguments, every .csv file in the current directory is read.',
        `Timestamps are grouped by calendar month in ${TIME_ZONE}.`,
    ].join('\n');
}

function monthInPerth(value) {
    if (!value || !value.trim()) {
        return null;
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return undefined;
    }

    const parts = MONTH_FORMATTER.formatToParts(date);
    const year = parts.find(({ type }) => type === 'year').value;
    const month = parts.find(({ type }) => type === 'month').value;

    return `${year}-${month}`;
}

function increment(results, month, field) {
    if (!results.has(month)) {
        results.set(month, {
            scheduled_out: 0,
            scheduled_off: 0,
            either: 0,
        });
    }

    results.get(month)[field] += 1;
}

async function countFile(inputPath, skipMissingColumns) {
    const results = new Map();
    const invalid = { scheduled_out: 0, scheduled_off: 0 };
    let rowCount = 0;
    let columnsChecked = false;

    const parser = fs.createReadStream(inputPath).pipe(parse({
        bom: true,
        columns: (header) => {
            const missing = REQUIRED_COLUMNS.filter((column) => !header.includes(column));
            if (missing.length > 0) {
                if (skipMissingColumns) {
                    parser.destroy();
                    return header;
                }
                throw new Error(`${inputPath}: missing required column(s): ${missing.join(', ')}`);
            }
            columnsChecked = true;
            return header;
        },
        delimiter: ';',
        relax_column_count: true,
        skip_empty_lines: true,
        trim: true,
    }));

    for await (const record of parser) {
        rowCount += 1;
        const monthsInRow = new Set();

        for (const field of REQUIRED_COLUMNS) {
            const month = monthInPerth(record[field]);
            if (month === undefined) {
                invalid[field] += 1;
            } else if (month !== null) {
                increment(results, month, field);
                monthsInRow.add(month);
            }
        }

        for (const month of monthsInRow) {
            increment(results, month, 'either');
        }
    }

    if (!columnsChecked && skipMissingColumns) {
        return { skipped: true };
    }
    if (!columnsChecked) {
        throw new Error(`${inputPath}: file is empty or has no header row`);
    }

    return { results, invalid, rowCount };
}

async function main() {
    const args = process.argv.slice(2);
    if (args.includes('--help') || args.includes('-h')) {
        console.log(usage());
        return;
    }

    const automaticScan = args.length === 0;
    const inputPaths = !automaticScan
        ? args
        : fs.readdirSync('.', { withFileTypes: true })
            .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.csv'))
            .map((entry) => entry.name)
            .sort();

    if (inputPaths.length === 0) {
        throw new Error('No CSV files found.');
    }

    const output = [];
    for (const inputPath of inputPaths) {
        if (!fs.existsSync(inputPath)) {
            throw new Error(`Input file not found: ${inputPath}`);
        }

        const fileResult = await countFile(inputPath, automaticScan);
        if (fileResult.skipped) {
            console.error(`${inputPath}: skipped (required schedule columns not found)`);
            continue;
        }
        const { results, invalid, rowCount } = fileResult;
        for (const [month, counts] of results) {
            output.push({ file: inputPath, month, ...counts });
        }

        console.error(`${inputPath}: ${rowCount.toLocaleString('en-US')} rows read`);
        if (invalid.scheduled_out || invalid.scheduled_off) {
            console.error(
                `${inputPath}: invalid timestamps skipped: scheduled_out=${invalid.scheduled_out}, `
                + `scheduled_off=${invalid.scheduled_off}`,
            );
        }
    }

    output.sort((a, b) => a.file.localeCompare(b.file) || a.month.localeCompare(b.month));
    console.table(output);
}

main().catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
});
