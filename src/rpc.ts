/* eslint-disable max-classes-per-file */
import {
  TotalBalance,
  AddressBalance,
  Transaction,
  RPCConfig,
  TxDetail,
  Info,
  SendProgress,
  AddressType,
  AddressDetail,
  WalletSettings,
} from "./components/AppState";
import { SendManyJson } from "./components/Send";

import native from "./native.node";

export default class RPC {
  rpcConfig?: RPCConfig;

  fnSetInfo: (info: Info) => void;
  fnSetTotalBalance: (tb: TotalBalance) => void;
  fnSetAddressesWithBalance: (abs: AddressBalance[]) => void;
  fnSetTransactionsList: (t: Transaction[]) => void;
  fnSetAllAddresses: (a: AddressDetail[]) => void;
  fnSetZecPrice: (p?: number) => void;
  fnSetWalletSettings: (settings: WalletSettings) => void;
  refreshTimerID?: NodeJS.Timeout;
  updateTimerId?: NodeJS.Timeout;

  updateDataLock: boolean;

  lastBlockHeight: number;
  lastTxId?: string;

  constructor(
    fnSetTotalBalance: (tb: TotalBalance) => void,
    fnSetAddressesWithBalance: (abs: AddressBalance[]) => void,
    fnSetTransactionsList: (t: Transaction[]) => void,
    fnSetAllAddresses: (a: AddressDetail[]) => void,
    fnSetInfo: (info: Info) => void,
    fnSetZecPrice: (p?: number) => void,
    fnSetWalletSettings: (settings: WalletSettings) => void
  ) {
    this.fnSetTotalBalance = fnSetTotalBalance;
    this.fnSetAddressesWithBalance = fnSetAddressesWithBalance;
    this.fnSetTransactionsList = fnSetTransactionsList;
    this.fnSetAllAddresses = fnSetAllAddresses;
    this.fnSetInfo = fnSetInfo;
    this.fnSetZecPrice = fnSetZecPrice;
    this.fnSetWalletSettings = fnSetWalletSettings;
    this.lastBlockHeight = 0;

    this.refreshTimerID = undefined;
    this.updateTimerId = undefined;
    this.updateDataLock = false;
  }

  async configure(rpcConfig: RPCConfig) {
    this.rpcConfig = rpcConfig;

    if (!this.refreshTimerID) {
      this.refreshTimerID = setInterval(() => this.refresh(false), 3 * 60 * 1000); // 3 mins
    }

    if (!this.updateTimerId) {
      this.updateTimerId = setInterval(() => this.updateData(), 3 * 1000); // 3 secs
    }

    // Immediately call the refresh after configure to update the UI
    this.refresh(true);
  }

  clearTimers() {
    if (this.refreshTimerID) {
      clearInterval(this.refreshTimerID);
      this.refreshTimerID = undefined;
    }

    if (this.updateTimerId) {
      clearInterval(this.updateTimerId);
      this.updateTimerId = undefined;
    }
  }

  static getDefaultFee(): number {
    const feeStr = native.litelib_execute("defaultfee", "");
    const fee = JSON.parse(feeStr);

    return fee.defaultfee / 10 ** 8;
  }

  static doSync() {
    const syncstr = native.litelib_execute("sync", "");
    console.log(`Sync exec result: ${syncstr}`);
  }

  static doRescan() {
    const syncstr = native.litelib_execute("rescan", "");
    console.log(`rescan exec result: ${syncstr}`);
  }

  static doSyncStatus(): string {
    const syncstr = native.litelib_execute("syncstatus", "");
    console.log(`syncstatus: ${syncstr}`);
    return syncstr;
  }

  static doSave() {
    const savestr = native.litelib_execute("save", "");
    console.log(`Save status: ${savestr}`);
  }

  static deinitialize() {
    const str = native.litelib_deinitialize();
    console.log(`Deinitialize status: ${str}`);
  }

  async updateData() {
    //console.log("Update data triggered");
    if (this.updateDataLock) {
      //console.log("Update lock, returning");
      return;
    }

    this.updateDataLock = true;
    const latest_txid = RPC.getLastTxid();

    if (this.lastTxId !== latest_txid) {
      console.log(`Latest: ${latest_txid}, prev = ${this.lastTxId}`);

      const latestBlockHeight = await this.fetchInfo();
      this.lastBlockHeight = latestBlockHeight;
      this.lastTxId = latest_txid;

      //console.log("Update data fetching new txns");

      // And fetch the rest of the data.
      this.fetchTotalBalance();
      this.fetchTandZTransactions(latestBlockHeight);
      this.getZecPrice();
      this.fetchWalletSettings();

      //console.log(`Finished update data at ${latestBlockHeight}`);
    }
    this.updateDataLock = false;
  }

  async refresh(fullRefresh: boolean) {
    const latestBlockHeight = await this.fetchInfo();

    if (fullRefresh || !this.lastBlockHeight || this.lastBlockHeight < latestBlockHeight) {
      this.updateDataLock = true;

      // If the latest block height has changed, make sure to sync. This will happen in a new thread
      RPC.doSync();

      // We need to wait for the sync to finish. The way we know the sync is done is
      // if the height matches the latestBlockHeight
      let retryCount = 0;
      const pollerID = setInterval(async () => {
        const walletHeight = RPC.fetchWalletHeight();
        retryCount += 1;

        // Wait a max of 30 retries (30 secs)
        if (walletHeight >= latestBlockHeight || retryCount > 30) {
          // We are synced. Cancel the poll timer
          clearInterval(pollerID);

          // And fetch the rest of the data.
          this.fetchTotalBalance();
          this.fetchTandZTransactions(latestBlockHeight);
          this.getZecPrice();

          this.lastBlockHeight = latestBlockHeight;

          // Save the wallet
          RPC.doSave();

          this.updateDataLock = false;

          // All done
          console.log(`Finished full refresh at ${latestBlockHeight}`);
        }
      }, 1000);
    } else {
      // Already at the latest block
      console.log("Already have latest block, waiting for next refresh");
    }
  }

  // Special method to get the Info object. This is used both internally and by the Loading screen
  static getInfoObject(): Info {
    const infostr = native.litelib_execute("info", "");
    console.log(`INFO INFO INFO: ${infostr}`);
    try {
      const infoJSON = JSON.parse(infostr);

      const info = new Info();
      info.testnet = infoJSON.chain_name === "test";
      info.latestBlock = infoJSON.latest_block_height;
      info.connections = 1;
      info.version = `${infoJSON.vendor}/${infoJSON.git_commit.substring(0, 6)}/${infoJSON.version}`;
      //info.zcashdVersion = infoJSON.zcashd_version;
      info.zcashdVersion = "Not Avaiable";
      info.verificationProgress = 1;
      info.currencyName = info.testnet ? "TAZ" : "ZEC";
      info.solps = 0;

      // Zingolib doesn't support any of these commands, so ignore them
      // const encStatus = native.litelib_execute("encryptionstatus", "");
      // const encJSON = JSON.parse(encStatus);
      // info.encrypted = encJSON.encrypted;
      // info.locked = encJSON.locked;

      info.encrypted = false;
      info.locked = false;

      // Also set `zecPrice` manually
      const resultStr = native.litelib_execute("updatecurrentprice", "");
      const resultJSON = JSON.parse(resultStr);
      if(resultJSON) info.zecPrice = resultJSON;

      const walletHeight = RPC.fetchWalletHeight();
      info.walletHeight = walletHeight;

      return info;
    } catch (err) {
      console.log("Failed to parse info", err);
      return new Info();
    }
  }

  static doImportPrivKey(key: string, birthday: string): string {
    const args = { key, birthday: parseInt(birthday, 10) };

    // eslint-disable-next-line no-restricted-globals
    if (isNaN(parseInt(birthday, 10))) {
      return `Error: Couldn't parse ${birthday} as a number`;
    }

    const address = native.litelib_execute("import", JSON.stringify(args));

    return address;
  }

  async fetchWalletSettings() {
    const download_memos_str = native.litelib_execute("getoption", "download_memos");
    const download_memos = JSON.parse(download_memos_str).download_memos;

    let spam_filter_threshold = "0";
    try {
      // const spam_filter_str = native.litelib_execute("getoption", "spam_filter_threshold");
      const spam_filter_str = native.litelib_execute("getoption", "transaction_filter_threshold");
      spam_filter_threshold = JSON.parse(spam_filter_str).spam_filter_threshold;
      // console.log(`Spam filter threshold: ${spam_filter_threshold}`);

      // If it is -1, i.e., it was not set, then set it to 50
      if (spam_filter_threshold === "-1") {
        //await RPC.setWalletSettingOption("spam_filter_threshold", "50");
        await RPC.setWalletSettingOption("transaction_filter_threshold", "50");
      }
    } catch (e) {
      console.log(`Error getting spam filter threshold: ${e}`);
    }

    const wallet_settings = new WalletSettings();
    wallet_settings.download_memos = download_memos;
    wallet_settings.spam_filter_threshold = parseInt(spam_filter_threshold);

    this.fnSetWalletSettings(wallet_settings);
  }

  static async setWalletSettingOption(name: string, value: string): Promise<string> {
    const r = native.litelib_execute("setoption", `${name}=${value}`);

    RPC.doSave();
    return r;
  }

  async fetchInfo(): Promise<number> {
    const info = RPC.getInfoObject();

    this.fnSetInfo(info);

    return info.latestBlock;
  }

  // Workaround for converting the `balance` command from zingolib to a format Zecwallet understand
  zingolibToZecwalletBalance(): any {
    const balanceStr = native.litelib_execute("balance", "");
    const balanceJSON = JSON.parse(balanceStr);

    let formattedJSON = {
      "uabalance": balanceJSON.orchard_balance,
      "zbalance": balanceJSON.sapling_balance,
      "verified_zbalance": balanceJSON.verified_sapling_balance,
      "spendable_zbalance": balanceJSON.spendable_sapling_balance,
      "unverified_zbalance": balanceJSON.unverified_sapling_balance,
      "tbalance": balanceJSON.transparent_balance,
      "ua_addresses": [],
      "z_addresses": [],
      "t_addresses": []
    };

    // fetch all addresses
    const addressesStr = native.litelib_execute('addresses','');
    const addressesJSON = JSON.parse(addressesStr);

    // fetch all notes
    const notesStr = native.litelib_execute('notes','');
    const notesJSON = JSON.parse(notesStr);

    // construct ua_addresses with their respective balance
    const ua_addr = addressesJSON
      .filter((a: any) => a.receivers.orchard_exists)
      .map((a: any) => {
    
      // To get the balance, sum all notes related to this address
      const ua_bal = notesJSON.unspent_orchard_notes
      .filter((o: any) => o.address === a.address)
      .reduce((acc: any, ua_unsp_note: any) => acc + ua_unsp_note.value, 0);
      
      // Also add pending notes
      const ua_pend_bal = notesJSON.pending_orchard_notes
        .filter((o: any) => o.address === a.address)
        .reduce((acc: any, ua_pend_note: any) => acc + ua_pend_note.value, 0);

      return {
        "address": a.address,
        "balance": ua_bal + ua_pend_bal,
        "receivers": JSON.stringify(a.receivers)
      }
    });

    // construct z_addresses with their respective balance
    const z_addr = addressesJSON
    .filter((a: any) => a.receivers.sapling)
    .map((a: any) => {
    // To get the balance, sum all notes related to this address
      const z_bal = notesJSON.unspent_sapling_notes
        .filter((o: any) => o.address === a.address)
        .reduce((acc: any, z_unsp_note: any) => acc + z_unsp_note.value, 0)

      // Also add pending notes
      const z_pend_bal = notesJSON.pending_sapling_notes
        .filter((o: any) => o.address === a.address)
        .reduce((acc: any, z_pend_note: any) => acc + z_pend_note, 0)

      // To get spendable balance, filter the unspent_sapling_notes where spendable = true
      const z_spendable_bal = notesJSON.unspent_sapling_notes
        .filter((o: any) => o.address === a.address && o.spendable)
        .reduce((acc: any, z_spendable_note: any) => acc + z_spendable_note.value, 0)
      
      return {
        "address": a.receivers.sapling,
        "zbalance": z_bal + z_pend_bal,
        "verified_zbalance": z_bal,
        "spendable_zbalance": z_spendable_bal,
        "unverified_zbalance": z_pend_bal
      }      
    });

    // construct t_addresses with their respective balance
    const t_addr = addressesJSON
      .filter((a: any) => a.receivers.transparent)
      .map((a: any) => {
        // To get the balance, sum all UTXOs related to this address
        const t_bal = notesJSON.utxos
        .filter((o: any) => o.address === a.address)
        .reduce((acc: any, t_utxo: any) => acc + t_utxo.value, 0)

        // Also add pending UTXOs
        const t_pend_bal = notesJSON.pending_utxos
        .filter((o: any) => o.address === a.address)
        .reduce((acc: any, t_pend_utxo: any) => acc + t_pend_utxo, 0)

        return {
          address: a.receivers.transparent,
          balance: t_bal + t_pend_bal
        }
      })

    // set corresponding addresses in the formatted Json
    formattedJSON.ua_addresses = ua_addr;
    formattedJSON.z_addresses = z_addr;
    formattedJSON.t_addresses = t_addr;
    
    return formattedJSON;
}

  // Workaround for converting the `notes` command from zingolib to a format Zecwallet understand
  zingolibToZecwalletNotes(): any {
    // fetch all notes
    const notesStr = native.litelib_execute('notes', '');
    const notesJSON = JSON.parse(notesStr);

    // fetch all addresses
    const addressesStr = native.litelib_execute('addresses','');
    const addressesJSON = JSON.parse(addressesStr);

    let formattedJSON = {
      "unspent_notes": [],
      "pending_notes": [],
      "utxos": [],
      "pending_utxos": []
    };

    // Construct unspent_notes concatenating unspent_orchard_notes and unspent_sapling_notes
    const ua_unsp_notes = notesJSON.unspent_orchard_notes;
    const z_unsp_notes = notesJSON.unspent_sapling_notes.map((z_unsp_note: any) =>{
      // need to get the sapling address, instead of ua address
      const z_addr = addressesJSON.find((a: any) => a.address === z_unsp_note.address);
      z_unsp_note.address = z_addr.receivers.sapling;
      
      return z_unsp_note;
    });
    
    const unsp_notes = ua_unsp_notes.concat(z_unsp_notes);

    // Construct pending_notes concatenating pending_orchard_notes and pending_sapling_notes
    const ua_pend_notes = notesJSON.pending_orchard_notes;
    const z_pend_notes = notesJSON.pending_sapling_notes.map((z_pend_note: any) =>{
      // need to get the sapling address, instead of ua address
      const z_addr = addressesJSON.find((a: any) => a.address === z_pend_note.address);
      z_pend_note.address = z_addr.receivers.sapling;
      
      return z_pend_note;
    });
    
    const pend_notes = ua_pend_notes.concat(z_pend_notes);
    
    // construct utxos, replacing the addresses accordingly
    const utxos = notesJSON.utxos.map((utxo: any) => {
      // need to get the transparent address, instead of ua address
      const t_addr = addressesJSON.find((a: any) => a.address === utxo.address);
      utxo.address = t_addr.receivers.transparent;

      return utxo;
    });

    // construct pending_utxos, replacing the addresses accordingly
    const pending_utxos = notesJSON.pending_utxos.map((pend_utxo: any) => {
      // need to get the transparent address, instead of ua address
      const t_addr = addressesJSON.find((a: any) => a.address === pend_utxo.address);
      pend_utxo.address = t_addr.receivers.transparent;

      return pend_utxo;
    });

    // Set corresponding fields
    formattedJSON.unspent_notes = unsp_notes;
    formattedJSON.pending_notes = pend_notes;
    formattedJSON.utxos = utxos;
    formattedJSON.pending_utxos = pending_utxos;
    
    return formattedJSON;
  }

  // Workaround for getting the `lasttxid` which is lacking in zingolib for some reason
  zingolibToZecwalletLastTxId(): any {
    const txListStr = native.litelib_execute("list", "");
    const txListJSON = JSON.parse(txListStr);
    
    // the last transaction id in the list should the lasttxid
    return {"last_txid": txListJSON[txListJSON.length - 1].txid};
  }

  zingolibToZecwalletTxList(): any {
    // fetch transaction list
    const txListStr = native.litelib_execute("list", "");
    const txListJSON = JSON.parse(txListStr);
  
    // fetch all notes
    const notesStr = native.litelib_execute('notes', '');
    const notesJSON = JSON.parse(notesStr);
  
    // fetch all addresses
    const addressesStr = native.litelib_execute('addresses','');
    const addressesJSON = JSON.parse(addressesStr);
  
    // construct the list, changing ua addresses to sappling addresses, when suitable
    const newTxList = txListJSON.map((tx: any) => {
      const note = notesJSON.unspent_sapling_notes.find((n: any) => n.created_in_txid === tx.txid);    
      
      if(note) {
        const z_addr = addressesJSON.find((a: any) => a.address === tx.address);
        tx.address = z_addr.receivers.sapling;
      }
  
      return tx;
    })
  
    return newTxList;
  }

  // This method will get the total balances
  fetchTotalBalance() {
    //const balanceStr = native.litelib_execute("balance", "");
    //const balanceJSON = JSON.parse(balanceStr);
    
    // Zingolib and zecwallet-cli gives different outputs for 'balance' command
    // As a simple hack, just construct the output from zingolib as zecwallet-cli does.
    const balanceJSON = this.zingolibToZecwalletBalance();

    console.log(balanceJSON);

    // Total Balance
    const balance = new TotalBalance();
    balance.uabalance = balanceJSON.uabalance / 10 ** 8;
    balance.zbalance = balanceJSON.zbalance / 10 ** 8;
    balance.transparent = balanceJSON.tbalance / 10 ** 8;
    balance.verifiedZ = balanceJSON.verified_zbalance / 10 ** 8;
    balance.unverifiedZ = balanceJSON.unverified_zbalance / 10 ** 8;
    balance.spendableZ = balanceJSON.spendable_zbalance / 10 ** 8;
    balance.total = balance.uabalance + balance.zbalance + balance.transparent;
    this.fnSetTotalBalance(balance);

    // Fetch pending notes and UTXOs    
    // const pendingNotes = native.litelib_execute("notes", "");
    // const pendingJSON = JSON.parse(pendingNotes);

    // Zingolib and zecwallet-cli gives different outputs for `notes` command
    // As a simple hack, just construct the output from zingolib as zecwallet-cli does.
    const pendingJSON = this.zingolibToZecwalletNotes();

    const pendingAddressBalances = new Map();

    // Process orchard + sapling notes
    pendingJSON.pending_notes.forEach((s: any) => {
      pendingAddressBalances.set(s.address, s.value);
    });

    // Process UTXOs
    pendingJSON.pending_utxos.forEach((s: any) => {
      pendingAddressBalances.set(s.address, s.value);
    });

    // Addresses with Balance. The lite client reports balances in zatoshi, so divide by 10^8;
    const oaddresses = balanceJSON.ua_addresses
      .map((o: any) => {
        // If this has any unconfirmed txns, show that in the UI
        const ab = new AddressBalance(o.address, o.balance / 10 ** 8);
        if (pendingAddressBalances.has(ab.address)) {
          ab.containsPending = true;
        }
        // Add receivers to unified addresses
        ab.receivers = o.receivers
        return ab;
      })
      .filter((ab: AddressBalance) => ab.balance > 0);

    const zaddresses = balanceJSON.z_addresses
      .map((o: any) => {
        // If this has any unconfirmed txns, show that in the UI
        const ab = new AddressBalance(o.address, o.zbalance / 10 ** 8);
        if (pendingAddressBalances.has(ab.address)) {
          ab.containsPending = true;
        }
        return ab;
      })
      .filter((ab: AddressBalance) => ab.balance > 0);

      console.log(zaddresses);

    const taddresses = balanceJSON.t_addresses
      .map((o: any) => {
        // If this has any unconfirmed txns, show that in the UI
        const ab = new AddressBalance(o.address, o.balance / 10 ** 8);
        if (pendingAddressBalances.has(ab.address)) {
          ab.containsPending = true;
        }
        return ab;
      })
      .filter((ab: AddressBalance) => ab.balance > 0);

    const addresses = oaddresses.concat(zaddresses.concat(taddresses));    

    this.fnSetAddressesWithBalance(addresses);

    // Also set all addresses
    const allOAddresses = balanceJSON.ua_addresses.map((o: any) => {
      let uaddr = new AddressDetail(o.address, AddressType.unified)
      uaddr.receivers = o.receivers;

      return uaddr;
    });
    const allZAddresses = balanceJSON.z_addresses.map((o: any) => new AddressDetail(o.address, AddressType.sapling));
    const allTAddresses = balanceJSON.t_addresses.map(
      (o: any) => new AddressDetail(o.address, AddressType.transparent)
    );
    const allAddresses = allOAddresses.concat(allZAddresses.concat(allTAddresses));    

    this.fnSetAllAddresses(allAddresses);
  }

  static getLastTxid(): string {
    // const lastTxid = native.litelib_execute("lasttxid", "");
    // const lastTxidJSON = JSON.parse(lastTxid);

    // for some reason, zingolib lacks this command, so let's use a hack
    // fetch transaction list, and then return de txid of the latest transaction in the list
    const txListStr = native.litelib_execute("list", "");
    const txListJSON = JSON.parse(txListStr);

    const lastTxidJSON = {"last_txid": txListJSON[txListJSON.length - 1].txid};

    return lastTxidJSON.last_txid;
  }

  static getPrivKeyAsString(address: string): string {
    const privKeyStr = native.litelib_execute("export", address);
    const privKeyJSON = JSON.parse(privKeyStr);

    return privKeyJSON[0].private_key;
  }

  static getViewKeyAsString(address: string): string {
    const privKeyStr = native.litelib_execute("export", address);
    const privKeyJSON = JSON.parse(privKeyStr);

    return privKeyJSON[0].viewing_key;
  }

  static createNewAddress(type: AddressType) {
    // const addrStr = native.litelib_execute(
    //   "new",
    //   type === AddressType.unified ? "u" : type === AddressType.sapling ? "z" : "t"
    // );

    // Zingolib creates addresses in a different way
    // ozt = orchard + sapling + transparent (orchard unified)
    // o = orchard only
    // oz = orchard + sapling
    // ot = orchard + transparent    
    // zt = spling + transparent
    // z = sapling only    
    // it's not possible to create a transparent only address    
    const addrStr = native.litelib_execute(
      "new",
      type === AddressType.unified ? "ozt" : type === AddressType.sapling ? "oz" : "ot"
    );
    const addrJSON = JSON.parse(addrStr);

    return addrJSON[0];
  }

  static fetchSeed(): string {
    const seedStr = native.litelib_execute("seed", "");
    const seedJSON = JSON.parse(seedStr);

    return seedJSON.seed;
  }

  static fetchWalletHeight(): number {
    const heightStr = native.litelib_execute("height", "");
    const heightJSON = JSON.parse(heightStr);

    return heightJSON.height;
  }

  // Fetch all T and Z transactions
  fetchTandZTransactions(latestBlockHeight: number) {
    // const listStr = native.litelib_execute("list", "");
    // const listJSON = JSON.parse(listStr);
    //console.log(listJSON);

    // Zingolib return transaction list with ua addresses for sapling transactions
    // we need to reconstruct it
    const listJSON = this.zingolibToZecwalletTxList();
    
    console.log(listJSON);

    let txlist: Transaction[] = listJSON.map((tx: any) => {
      const transaction = new Transaction();

      const type = tx.outgoing_metadata ? "sent" : "receive";

      transaction.address =
        // eslint-disable-next-line no-nested-ternary
        type === "sent" ? (tx.outgoing_metadata.length > 0 ? tx.outgoing_metadata[0].address : "") : tx.address;
      transaction.type = type;
      transaction.amount = tx.amount / 10 ** 8;
      transaction.confirmations = tx.unconfirmed ? 0 : latestBlockHeight - tx.block_height + 1;
      transaction.txid = tx.txid;
      transaction.zecPrice = tx.zec_price;
      transaction.time = tx.datetime;
      transaction.position = tx.position;

      if (tx.outgoing_metadata) {
        const dts = tx.outgoing_metadata.map((o: any) => {
          const detail = new TxDetail();
          detail.address = o.address;
          detail.amount = (o.value / 10 ** 8).toFixed(8);
          detail.memo = o.memo;

          return detail;
        });

        transaction.detailedTxns = RPC.combineTxDetails(dts);
      } else {
        transaction.detailedTxns = [new TxDetail()];
        transaction.detailedTxns[0].address = tx.address;
        transaction.detailedTxns[0].amount = (tx.amount / 10 ** 8).toFixed(8);
        transaction.detailedTxns[0].memo = tx.memo;
      }

      return transaction;
    });

    // If you send yourself transactions, the underlying SDK doesn't handle it very well, so
    // we supress these in the UI to make things a bit clearer.
    txlist = txlist.filter((tx) => !(tx.type === "sent" && tx.amount < 0 && tx.detailedTxns.length === 0));

    // We need to group transactions that have the same (txid and send/recive), for multi-part memos
    const m = new Map<string, Transaction[]>();
    txlist.forEach((tx) => {
      const key = tx.txid + tx.type;
      const coll = m.get(key);
      if (!coll) {
        m.set(key, [tx]);
      } else {
        coll.push(tx);
      }
    });

    // Now, combine the amounts and memos
    const combinedTxList: Transaction[] = [];
    m.forEach((txns) => {
      // Get all the txdetails and merge them

      // Clone the first tx into a new one
      // eslint-disable-next-line prefer-object-spread
      const combinedTx = Object.assign({}, txns[0]);
      combinedTx.detailedTxns = RPC.combineTxDetails(txns.flatMap((tx) => tx.detailedTxns));

      combinedTxList.push(combinedTx);
    });

    // Sort the list by confirmations
    combinedTxList.sort((t1, t2) => t1.confirmations - t2.confirmations);

    this.fnSetTransactionsList(combinedTxList);
  }

  // We combine detailed transactions if they are sent to the same outgoing address in the same txid. This
  // is usually done to split long memos.
  // Remember to add up both amounts and combine memos
  static combineTxDetails(txdetails: TxDetail[]): TxDetail[] {
    // First, group by outgoing address.
    const m = new Map<string, TxDetail[]>();
    txdetails.forEach((i) => {
      const coll = m.get(i.address);
      if (!coll) {
        m.set(i.address, [i]);
      } else {
        coll.push(i);
      }
    });

    // Reduce the groups to a single TxDetail, combining memos and summing amounts
    const reducedDetailedTxns: TxDetail[] = [];
    m.forEach((txns, toaddr) => {
      const totalAmount = txns.reduce((p, td) => p + parseFloat(td.amount), 0);

      const memos = txns
        .filter((i) => i.memo)
        .map((i) => {
          const rex = /\((\d+)\/(\d+)\)((.|[\r\n])*)/;
          const tags = i.memo?.match(rex);
          if (tags && tags.length >= 4) {
            return { num: parseInt(tags[1], 10), memo: tags[3] };
          }

          // Just return as is
          return { num: 0, memo: i.memo };
        })
        .sort((a, b) => a.num - b.num)
        .map((a) => a.memo);

      const detail = new TxDetail();
      detail.address = toaddr;
      detail.amount = totalAmount.toFixed(8);
      detail.memo = memos.length > 0 ? memos.join("") : null;

      reducedDetailedTxns.push(detail);
    });

    return reducedDetailedTxns;
  }

  // Send a transaction using the already constructed sendJson structure
  async sendTransaction(sendJson: SendManyJson[], setSendProgress: (p?: SendProgress) => void): Promise<string> {
    // First, get the previous send progress id, so we know which ID to track
    const prevProgress = JSON.parse(native.litelib_execute("sendprogress", ""));
    const prevSendId = prevProgress.id;

    try {
      console.log(`Sending ${JSON.stringify(sendJson)}`);
      native.litelib_execute("send", JSON.stringify(sendJson));
    } catch (err) {
      // TODO Show a modal with the error
      console.log(`Error sending Tx: ${err}`);
      throw err;
    }

    const startTimeSeconds = new Date().getTime() / 1000;

    // The send command is async, so we need to poll to get the status
    const sendTxPromise: Promise<string> = new Promise((resolve, reject) => {
      const intervalID = setInterval(() => {
        const progress = JSON.parse(native.litelib_execute("sendprogress", ""));
        console.log(progress);

        const updatedProgress = new SendProgress();
        if (progress.id === prevSendId) {
          // Still not started, so wait for more time
          setSendProgress(updatedProgress);
          return;
        }

        // Calculate ETA.
        let secondsPerComputation = 3; // defalt
        if (progress.progress > 0) {
          const currentTimeSeconds = new Date().getTime() / 1000;
          secondsPerComputation = (currentTimeSeconds - startTimeSeconds) / progress.progress;
        }
        // console.log(`Seconds Per compute = ${secondsPerComputation}`);

        let eta = Math.round((progress.total - progress.progress) * secondsPerComputation);
        if (eta <= 0) {
          eta = 1;
        }

        updatedProgress.progress = progress.progress;
        updatedProgress.total = Math.max(progress.total, progress.progress); // sometimes, due to change, the total can be off by 1
        updatedProgress.sendInProgress = true;
        updatedProgress.etaSeconds = eta;

        if (progress.id === prevSendId) {
          // Still not started, so wait for more time
          setSendProgress(updatedProgress);
          return;
        }

        if (!progress.txid && !progress.error) {
          // Still processing
          setSendProgress(updatedProgress);
          return;
        }

        // Finished processing
        clearInterval(intervalID);
        setSendProgress(undefined);

        if (progress.txid) {
          // And refresh data (full refresh)
          this.refresh(true);

          resolve(progress.txid as string);
        }

        if (progress.error) {
          reject(progress.error as string);
        }
      }, 2 * 1000); // Every 2 seconds
    });

    return sendTxPromise;
  }

  async encryptWallet(password: string): Promise<boolean> {
    const resultStr = native.litelib_execute("encrypt", password);
    const resultJSON = JSON.parse(resultStr);

    // To update the wallet encryption status
    this.fetchInfo();

    // And save the wallet
    RPC.doSave();

    return resultJSON.result === "success";
  }

  async decryptWallet(password: string): Promise<boolean> {
    const resultStr = native.litelib_execute("decrypt", password);
    const resultJSON = JSON.parse(resultStr);

    // To update the wallet encryption status
    this.fetchInfo();

    // And save the wallet
    RPC.doSave();

    return resultJSON.result === "success";
  }

  async lockWallet(): Promise<boolean> {
    const resultStr = native.litelib_execute("lock", "");
    const resultJSON = JSON.parse(resultStr);

    // To update the wallet encryption status
    this.fetchInfo();

    return resultJSON.result === "success";
  }

  async unlockWallet(password: string): Promise<boolean> {
    const resultStr = native.litelib_execute("unlock", password);
    const resultJSON = JSON.parse(resultStr);

    // To update the wallet encryption status
    this.fetchInfo();

    return resultJSON.result === "success";
  }

  async getZecPrice() {    
    //const resultStr: string = native.litelib_execute("zecprice", "");
    // zingo uses a different command for getting zec price
    const resultStr: string = native.litelib_execute("updatecurrentprice", "");

    if (resultStr.toLowerCase().startsWith("error")) {
      console.log(`Error fetching price ${resultStr}`);
      return;
    }
    
    const resultJSON = JSON.parse(resultStr);
    // if (resultJSON.zec_price) {
    //   this.fnSetZecPrice(resultJSON.zec_price);
    // }
    
    if (resultJSON) {      
      this.fnSetZecPrice(resultJSON);
    }
  }
}
