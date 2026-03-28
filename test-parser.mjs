import { JSONParser } from '@streamparser/json';

const parser = new JSONParser({ paths: ['$.data.runs.*.*'], keepStack: false });

parser.onValue = ({ value, key, parent, stack }) => {
    console.log("Matched key:", key);
    console.log("Stack keys:", stack.map(s => s.key));
    console.log("Has requests:", !!value.requests);
};

const rawTest = {
    data: {
        runs: {
            "1": {
                firstView: { requests: [1, 2, 3] },
                repeatView: { requests: [4, 5, 6] }
            },
            "2": {
                firstView: { requests: [7] }
            }
        }
    }
};

parser.write(JSON.stringify(rawTest));
