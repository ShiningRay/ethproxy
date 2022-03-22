export interface Block {
  number: number;
  hash: string;
  parentHash: string;
}

export interface Transaction {
  blockHash: string | null;
  blockNumber: string | null; // hex string
  from: string;
  gas: string;
  gasPrice: string
  hash: string;
  input: string;
  nonce: string;
  to: string | null;
  transactionIndex: string | null;
  value: string;
  v: string;
  r: string;
  s: string;
}

export interface EventLog {
  "logIndex": string //hex 
  "blockNumber": string // hex
  "blockHash": string
  "transactionHash": string
  "transactionIndex": string // hex
  "address": string
  "data": string
  "topics": string[]
}


export enum TransactionStatus {
  Success = '0x1',
  Failure = '0x0'
}
export interface TransactionReceipt {
  transactionHash: string;
  transactionIndex: string;
  blockHash: string;
  blockNumber: string;
  from: string;
  to: string;
  cumulativeGasUsed: string;
  gasUsed: string;
  contractAddress: string | null;
  logs: EventLog[];
  logsBloom: string;
  status: TransactionStatus;
}
