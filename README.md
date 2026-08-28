# Thesis DATA

## Count scheduled records by month

Count non-empty `scheduled_out` and `scheduled_off` values in each CSV by
calendar month in the `Australia/Perth` timezone:

```sh
npm run count-schedules
```

With no arguments, the script reads all `.csv` files in the current directory.
Pass one or more paths to select files, for example
`npm run count-schedules -- test.csv combined.csv`. The `either` column counts
a record once in each month in which it has either schedule field; the two
schedule columns count their respective fields independently.

## Inquire Data
`nohup node --env-file=.env inquire-data.js > result_test_001.csv 2>&1`
