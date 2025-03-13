import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import Arweave from "arweave";
import { connect, createDataItemSigner, dryrun, message, result } from "@permaweb/aoconnect";
import { Client, GatewayIntentBits } from "discord.js";
import crypto from "crypto";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DERIVED_JWKS_DIR = path.join(__dirname, 'derived_jwks');
if (!fs.existsSync(DERIVED_JWKS_DIR)) {
    fs.mkdirSync(DERIVED_JWKS_DIR);
    console.log(`[${new Date().toISOString()}] ✅ Created directory: ${DERIVED_JWKS_DIR}`);
}


// **Wallet Setup**
const WALLET_PATH = process.env.ARWEAVE_WALLET_PATH;
if (!WALLET_PATH) throw new Error("Missing ARWEAVE_WALLET_PATH");
let masterKey;
try {
    masterKey = JSON.parse(fs.readFileSync(path.resolve(__dirname, WALLET_PATH), "utf8"));
    console.log(`[${new Date().toISOString()}] ✅ Master key loaded`);
} catch (err) {
    console.error(`[${new Date().toISOString()}] 🚨 Failed to load key: ${err.message}`);
    process.exit(1);
}

// **Arweave Initialization**
const arweave = Arweave.init({
    host: process.env.ARWEAVE_HOST || "arweave.net",
    port: Number(process.env.ARWEAVE_PORT) || 443,
    protocol: process.env.ARWEAVE_PROTOCOL || "https",
    timeout: 60000
});

// **AO Connect Setup**
const ao = connect({
    MU_URL: process.env.MU_URL,
    CU_URL: process.env.CU_URL,
    GATEWAY_URL: process.env.GATEWAY_URL
});
if (!ao) throw new Error("AO Connect failed");
console.log(`[${new Date().toISOString()}] 🔗 AO Connect initialized`);
const signer = createDataItemSigner(masterKey);

// **Environment Variables**
const AO_PROCESS_ID = process.env.AO_PROCESS_ID;
const SEND_TOKEN_PROCESS_ID = process.env.SEND_TOKEN_PROCESS_ID;
const SCHEDULER = process.env.SCHEDULER;
const AUTHORITY = process.env.AUTHORITY;
const PARENT_PROCESS_ID = process.env.PARENT_PROCESS_ID;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!AO_PROCESS_ID || !SEND_TOKEN_PROCESS_ID || !SCHEDULER || !AUTHORITY || !PARENT_PROCESS_ID || !DISCORD_TOKEN) {
    throw new Error("Missing required environment variables");
}

// **Persistent Storage**
const PROCESS_STORAGE_FILE = path.join(__dirname, "processes.json");
let userAccounts = {};
try {
    if (fs.existsSync(PROCESS_STORAGE_FILE)) {
        userAccounts = JSON.parse(fs.readFileSync(PROCESS_STORAGE_FILE, "utf8"));
        console.log(`[${new Date().toISOString()}] 🔄 Loaded user accounts`);
    } else {
        fs.writeFileSync(PROCESS_STORAGE_FILE, JSON.stringify({}, null, 2));
    }
} catch (err) {
    console.error(`[${new Date().toISOString()}] 🚨 Storage error: ${err.message}`);
    process.exit(1);
}

function saveUserAccounts() {
    try {
        fs.writeFileSync(PROCESS_STORAGE_FILE, JSON.stringify(userAccounts, null, 2));
        console.log(`[${new Date().toISOString()}] ✅ Accounts saved`);
    } catch (err) {
        console.error(`[${new Date().toISOString()}] 🚨 Save error: ${err.message}`);
    }
}

// **Generate Deposit Address**
async function generateDepositAddress(userId) {
    const keypairFile = path.join(DERIVED_JWKS_DIR, `${userId}.json`);
    
    // If a derived keypair already exists for this user, load it
    if (fs.existsSync(keypairFile)) {
        const savedKeypair = JSON.parse(fs.readFileSync(keypairFile, "utf8"));
        const depositAddress = await arweave.wallets.jwkToAddress(savedKeypair);
        console.log(`[${new Date().toISOString()}] ✅ Loaded existing derived wallet for ${userId}: ${depositAddress}`);
        return { address: depositAddress, keypair: savedKeypair };
    }
    
    // Otherwise, generate a new derived keypair
    const derivationIndex = Object.keys(userAccounts).length + 1;
    const derivationPath = `m/44'/1729'/${derivationIndex}'/0/0`;
    const childKeypair = await arweave.wallets.generate(masterKey, { path: derivationPath });
    const depositAddress = await arweave.wallets.jwkToAddress(childKeypair);
    
    // Save the new keypair to the file system
    fs.writeFileSync(keypairFile, JSON.stringify(childKeypair, null, 2));
    console.log(`[${new Date().toISOString()}] ✅ Generated and saved new derived wallet for ${userId}: ${depositAddress}`);
    
    return { address: depositAddress, keypair: childKeypair };
}
// **Optimized ensureUserProcess**
async function ensureUserProcess(userId, retryCount = 0) {
    if (!userId || typeof userId !== "string" || userId.trim() === "") {
        console.error(`[${new Date().toISOString()}] 🚨 Invalid userId`);
        return null;
    }

    // Check local storage first
    if (userAccounts[userId]?.processId) {
        console.log(`[${new Date().toISOString()}] 🔄 Found existing AO process: ${userAccounts[userId].processId}`);
        return userAccounts[userId];
    }

    // Query ledger for existing process
    async function queryLedger() {
        try {
            const queryTx = await message({
                process: AO_PROCESS_ID,
                tags: [
                    { name: "Action", value: "Get-User-Process" },
                    { name: "User-ID", value: userId }
                ],
                signer
            });
            const queryResult = await result({ message: queryTx, process: AO_PROCESS_ID, timeout: 5000 });
            if (queryResult.Messages?.[0]?.Data) {
                const data = JSON.parse(queryResult.Messages[0].Data);
                if (data.Success && data.processId) {
                    userAccounts[userId] = {
                        processId: data.processId,
                        depositAddress: data.depositAddress,
                        discordId: userId,
                        lastKnownBalance: data.balance || 0,
                        senditStreak: userAccounts[userId]?.senditStreak || 0,
                        lastSenditTime: userAccounts[userId]?.lastSenditTime || 0,
                        senditHistory: userAccounts[userId]?.senditHistory || []
                    };
                    saveUserAccounts();
                    console.log(`[${new Date().toISOString()}] ✅ Ledger returned process: ${data.processId}`);
                    return userAccounts[userId];
                }
            }
            return null;
        } catch (err) {
            console.warn(`[${new Date().toISOString()}] ⚠️ Ledger query failed: ${err.message}`);
            return null;
        }
    }

    let account = await queryLedger();
    if (account) return account;

    // Spawn new process and wait for parent response
    if (retryCount === 0) {
        try {
            const depositInfo = await generateDepositAddress(userId);
            const spawnNonce = crypto.randomBytes(16).toString("hex");
            const spawnMsg = {
                process: PARENT_PROCESS_ID,
                tags: [
                    { name: "Action", value: "Spawn-Child" },
                    { name: "User-ID", value: userId },
                    { name: "Deposit-Address", value: depositInfo.address },
                    { name: "Scheduler", value: SCHEDULER },
                    { name: "Authority", value: AUTHORITY },
                    { name: "Nonce", value: spawnNonce }
                ],
                signer
            };
            const spawnTx = await message(spawnMsg);
            console.log(`[${new Date().toISOString()}] 📤 Spawn-Child request sent for ${userId}, TX: ${spawnTx}`);

            // Wait for parent response
            const spawnResult = await result({ message: spawnTx, process: PARENT_PROCESS_ID, timeout: 5000 });
            if (spawnResult.Messages?.[0]?.Data) {
                const data = JSON.parse(spawnResult.Messages[0].Data);
                if (data.Success && data.childProcessId) {
                    userAccounts[userId] = {
                        processId: data.childProcessId,
                        depositAddress: depositInfo.address,
                        keypair: depositInfo.keypair, 
                        discordId: userId,
                        lastKnownBalance: 0,
                        senditStreak: 0,
                        lastSenditTime: 0,
                        senditHistory: []
                    };
                    saveUserAccounts();
                    console.log(`[${new Date().toISOString()}] ✅ Parent returned child process: ${data.childProcessId}`);
                    return userAccounts[userId];
                }
            }
            console.warn(`[${new Date().toISOString()}] ⚠️ No valid spawn response from parent`);
        } catch (err) {
            console.error(`[${new Date().toISOString()}] 🚨 Spawn error: ${err.message}`);
            return null;
        }
    }

    // Retry querying the ledger as a fallback (5 attempts, 1-second intervals)
    const maxRetries = 5;
    if (retryCount < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        return ensureUserProcess(userId, retryCount + 1);
    }
    console.error(`[${new Date().toISOString()}] 🚨 Process registration not found after ${maxRetries} retries`);
    return null;
}

// Check balance 
async function checkBalance(userId, retries = 0) {
    const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);
    log(`📥 Starting balance check for user ${userId} (retry ${retries})`);

    const account = await ensureUserProcess(userId);
    if (!account || !account.depositAddress) {
        log(`🚨 No deposit address for ${userId}`);
        return { balance: 0, message: "No deposit address found. Use !deposit first." };
    }
    log(`✅ Account found: Process ID: ${account.processId}, Deposit Address: ${account.depositAddress}`);

    // Check cache first (5-second timeout, adjust or remove as preferred)
    const cacheTimeout = 1 * 100; // 5 seconds
    if (account.lastBalanceCheck && Date.now() - account.lastBalanceCheck < cacheTimeout) {
        log(`🔄 Using cached balance: ${account.lastKnownBalance} SEND`);
        return {
            balance: account.lastKnownBalance,
            message: `Your balance: **${account.lastKnownBalance.toFixed(2)} SEND** (cached)`
        };
    }

    // Query on-chain balance with dryrun
    let onChainBalance = 0;
    try {
        log(`📤 Sending dryrun balance query to ${SEND_TOKEN_PROCESS_ID} for ${account.depositAddress}`);
        const balanceResult = await dryrun({
            process: SEND_TOKEN_PROCESS_ID,
            tags: [
                { name: "Action", value: "Balance" },
                { name: "Target", value: account.depositAddress }
            ]
        });
        log(`📥 Dryrun result received: ${JSON.stringify(balanceResult)}`);

        if (balanceResult.Messages?.[0]?.Tags) {
            const balanceTag = balanceResult.Messages[0].Tags.find(tag => tag.name === "Balance");
            if (balanceTag) {
                onChainBalance = Number(balanceTag.value) / 1e18;
                log(`✅ On-chain balance: ${onChainBalance} SEND`);
            } else {
                log(`⚠️ No 'Balance' tag found in response`);
            }
        } else {
            log(`⚠️ No messages or tags in dryrun response`);
        }
    } catch (err) {
        log(`🚨 Dryrun balance query failed: ${err.message}`);
        if (retries < 3) {
            log(`⏳ Retrying after 2 seconds (retry ${retries + 1})`);
            await new Promise(resolve => setTimeout(resolve, 2000));
            return checkBalance(userId, retries + 1);
        }
        log(`🔴 Max retries reached, proceeding with internal balance`);
    }

    // Get internal balance with a real message to get a TX ID
    let internalBalance = account.lastKnownBalance || 0;
    let internalTxLink = "";
    try {
        log(`📤 Sending internal balance query to ${AO_PROCESS_ID} for ${account.processId}`);
        const internalTx = await message({
            process: AO_PROCESS_ID,
            tags: [
                { name: "Action", value: "Get-Balance" },
                { name: "Process-ID", value: account.processId }
            ],
            signer
        });
        log(`📨 Internal balance TX sent: ${internalTx}`);
        internalTxLink = `[View](https://www.ao.link/#/message/${internalTx})`;

        const internalResult = await result({ message: internalTx, process: AO_PROCESS_ID, timeout: 10000 });
        log(`📥 Internal balance result: ${JSON.stringify(internalResult)}`);

        if (internalResult.Messages?.[0]?.Data) {
            const data = JSON.parse(internalResult.Messages[0].Data);
            if (data.Success) {
                internalBalance = Number(data.balance) / 1e18;
                log(`✅ Internal balance: ${internalBalance} SEND`);
            } else {
                log(`⚠️ Internal balance query failed: ${data.message}`);
            }
        }
    } catch (err) {
        log(`🚨 Internal balance query failed: ${err.message}`);
    }

    // Sync if on-chain balance is higher
    let syncMessage = "";
    if (onChainBalance > internalBalance) {
        const adjustment = onChainBalance - internalBalance;
        const creditNonce = crypto.randomBytes(16).toString("hex");
        log(`🔄 Syncing internal balance, adjustment: ${adjustment} SEND`);

        const creditMsg = {
            process: AO_PROCESS_ID,
            data: JSON.stringify({
                processId: account.processId,
                amount: Math.floor(adjustment * 1e18)
            }),
            tags: [
                { name: "Action", value: "CreditBalance" },
                { name: "Nonce", value: creditNonce }
            ],
            signer
        };
        try {
            const creditTx = await message(creditMsg);
            log(`📨 Credit TX sent: ${creditTx}`);
            const creditResult = await result({ message: creditTx, process: AO_PROCESS_ID, timeout: 10000 });
            log(`📥 Credit result: ${JSON.stringify(creditResult)}`);

            if (creditResult.Messages?.[0]?.Data) {
                const creditData = JSON.parse(creditResult.Messages[0].Data);
                if (creditData.Success) {
                    internalBalance = Number(creditData.NewBalance) / 1e18;
                    account.lastKnownBalance = internalBalance;
                    saveUserAccounts();
                    syncMessage = ` (Synced from on-chain. TX: [View](https://www.ao.link/#/message/${creditTx}))`;
                    log(`✅ Synced internal balance to ${internalBalance} SEND`);
                }
            }
        } catch (err) {
            log(`🚨 Credit balance error: ${err.message}`);
        }
    }

    // Update cache
    account.lastBalanceCheck = Date.now();
    account.lastKnownBalance = internalBalance;
    saveUserAccounts();
    log(`💾 Balance cached: ${internalBalance} SEND`);

    log(`🔚 Final balance for ${userId}: ${internalBalance} SEND`);
    return {
        balance: internalBalance,
        message: `Your balance: **${internalBalance.toFixed(2)} SEND**${internalTxLink ? ` (Internal check TX: ${internalTxLink})` : ""}${syncMessage}`
    };
}

// **Handle Internal Transfer (Tip)**
async function handleInternalTransfer(senderId, receiverId, tipAmount) {
    const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);
    if (tipAmount <= 0) return "❌ Invalid amount.";
  
    // Retrieve sender and receiver accounts
    const senderAccount = await ensureUserProcess(senderId);
    const receiverAccount = await ensureUserProcess(receiverId);
    if (!senderAccount || !receiverAccount) return "❌ Failed to retrieve accounts.";
  
    // Get the ledger's internal balance (L)
    const checkResult = await checkBalance(senderId);
    let internalBalance = checkResult.balance; // L
  
    // Get the derived wallet's on-chain balance (D) via dryrun
    let derivedBalance = 0;
    try {
      const dryrunResult = await dryrun({
        process: SEND_TOKEN_PROCESS_ID,
        tags: [
          { name: "Action", value: "Balance" },
          { name: "Target", value: senderAccount.depositAddress }
        ]
      });
      if (dryrunResult.Messages && dryrunResult.Messages.length > 0) {
        const balanceTag = dryrunResult.Messages[0].Tags.find(tag => tag.name === "Balance");
        if (balanceTag) {
          derivedBalance = Number(balanceTag.value) / 1e18;
        }
      }
    } catch (err) {
      log(`🚨 Dryrun balance query failed: ${err.message}`);
    }
    
    log(`Sender internal balance (L): ${internalBalance} SEND, Derived on-chain balance (D): ${derivedBalance} SEND`);
    
    // Total available funds = L + D
    const totalAvailable = internalBalance + derivedBalance;
    if (totalAvailable < tipAmount) {
      return "❌ Insufficient funds.";
    }
  
    // If there is any on-chain derived balance, sweep it completely.
    // This moves all D from the derived wallet to the primary wallet.
    if (derivedBalance > 0) {
      log(`Sweeping entire derived wallet balance of ${derivedBalance} SEND.`);
      const sweepSuccess = await sweepDerivedWallet(senderId, senderAccount.depositAddress, derivedBalance);
      if (!sweepSuccess) {
        return "❌ Failed to sweep derived funds; tip aborted.";
      }
      // Now that D has been swept, update the ledger internal balance.
      // We send a CreditBalance message for the full swept amount.
      const creditNonce = crypto.randomBytes(16).toString("hex");
      const creditMsg = {
        process: AO_PROCESS_ID,
        data: JSON.stringify({
          processId: senderAccount.processId,
          amount: Math.floor(derivedBalance * 1e18)
        }),
        tags: [
          { name: "Action", value: "CreditBalance" },
          { name: "Nonce", value: creditNonce }
        ],
        signer
      };
      try {
        const creditTx = await message(creditMsg);
        const creditResult = await result({ message: creditTx, process: AO_PROCESS_ID, timeout: 10000 });
        log(`Credit result: ${JSON.stringify(creditResult)}`);
        if (creditResult.Messages && creditResult.Messages.length > 0) {
          const creditData = JSON.parse(creditResult.Messages[0].Data);
          if (creditData.Success) {
            internalBalance = Number(creditData.NewBalance) / 1e18;
            senderAccount.lastKnownBalance = internalBalance;
            saveUserAccounts();
            log(`Internal balance updated to ${internalBalance} SEND after sweeping and credit.`);
          } else {
            log(`CreditBalance failed: ${creditData.message}`);
            return "❌ Failed to update internal balance after sweep.";
          }
        }
      } catch (err) {
        log(`🚨 Credit balance error: ${err.message}`);
        return "❌ Failed to update internal balance after sweep.";
      }
    }
  
    // At this point, the sender's internal balance (L) now reflects all funds (L + D).
    // Now, perform the internal transfer for the tip.
    const transferNonce = crypto.randomBytes(16).toString("hex");
    const transferMsg = {
      process: AO_PROCESS_ID,
      tags: [
        { name: "Action", value: "TransferBalance" },
        { name: "From-Process-ID", value: senderAccount.processId },
        { name: "To-Process-ID", value: receiverAccount.processId },
        { name: "Amount", value: String(Math.floor(tipAmount * 1e18)) },
        { name: "Nonce", value: transferNonce }
      ],
      signer // using the primary (master) signer for internal ledger messages
    };
  
    try {
      const transferTx = await message(transferMsg);
      log(`📨 Transfer TX sent: ${transferTx}`);
      const transferResult = await result({ message: transferTx, process: AO_PROCESS_ID, timeout: 5000 });
      log(`📥 Transfer result: ${JSON.stringify(transferResult)}`);
      if (!transferResult.Messages || transferResult.Messages.length === 0) {
        throw new Error("No transfer response received");
      }
      const data = JSON.parse(transferResult.Messages[0].Data);
      if (data.Success) {
        // Deduct tipAmount from the sender's internal balance
        senderAccount.lastKnownBalance -= tipAmount;
        // Credit the receiver's internal balance with tipAmount
        receiverAccount.lastKnownBalance = (receiverAccount.lastKnownBalance || 0) + tipAmount;
        saveUserAccounts();
        const senderMention = `<@${senderId}>`;
        const receiverMention = `<@${receiverId}>`;
        return `${senderMention} tipped ${receiverMention} ${tipAmount} SEND (TX: [View](https://www.ao.link/#/message/${transferTx}))`;
      }
      return `❌ Transfer failed: ${data.message}`;
    } catch (err) {
      log(`🚨 Transfer error: ${err.message}`);
      return "❌ Transfer failed.";
    }
  }  
  
// Debit balance after transfer 
async function debitInternalBalance(userId, amount) {
    const account = await ensureUserProcess(userId);
    if (!account) return false;
    const debitNonce = crypto.randomBytes(16).toString("hex");
    const debitMsg = {
      process: AO_PROCESS_ID,
      data: JSON.stringify({
        processId: account.processId,
        amount: Math.floor(amount * 1e18)
      }),
      tags: [
        { name: "Action", value: "DebitBalance" },
        { name: "Nonce", value: debitNonce }
      ],
      signer
    };
    try {
      const debitTx = await message(debitMsg);
      const debitResult = await result({ message: debitTx, process: AO_PROCESS_ID, timeout: 10000 });
      if (debitResult.Messages && debitResult.Messages.length > 0) {
        const debitData = JSON.parse(debitResult.Messages[0].Data);
        if (debitData.Success) {
          account.lastKnownBalance = Number(debitData.NewBalance) / 1e18;
          saveUserAccounts();
          return true;
        }
      }
      return false;
    } catch (err) {
      console.error(`[${new Date().toISOString()}] 🚨 Debit error: ${err.message}`);
      return false;
    }
  }
  
  // **Handle Withdrawal**
  async function handleWithdraw(userId, amount, walletAddress) {
    const account = await ensureUserProcess(userId);
    if (!account) return "❌ No process found.";
    
    // Check the full balance (internal ledger + derived wallet)
    const balanceData = await checkBalance(userId);
    let internalBalance = balanceData.balance; // L
    
    // Get derived wallet balance via dryrun
    let derivedBalance = 0;
    try {
      const dryrunResult = await dryrun({
        process: SEND_TOKEN_PROCESS_ID,
        tags: [
          { name: "Action", value: "Balance" },
          { name: "Target", value: account.depositAddress }
        ]
      });
      if (dryrunResult.Messages && dryrunResult.Messages.length > 0) {
        const balanceTag = dryrunResult.Messages[0].Tags.find(tag => tag.name === "Balance");
        if (balanceTag) {
          derivedBalance = Number(balanceTag.value) / 1e18;
        }
      }
    } catch (err) {
      console.error(`[${new Date().toISOString()}] 🚨 Dryrun balance query failed: ${err.message}`);
    }
    
    // Total available funds = internal balance + derived balance
    const totalAvailable = internalBalance + derivedBalance;
    if (totalAvailable < amount) return "❌ Insufficient funds.";
    
    // If there is any derived balance, sweep it and update the ledger.
    if (derivedBalance > 0) {
      console.log(`[${new Date().toISOString()}] 🔄 Sweeping derived wallet balance of ${derivedBalance} SEND before withdrawal.`);
      const sweepSuccess = await sweepDerivedWallet(userId, account.depositAddress, derivedBalance);
      if (!sweepSuccess) return "❌ Failed to sweep derived funds; withdrawal aborted.";
      
      // After sweep, update the ledger's internal balance with a CreditBalance message.
      const creditNonce = crypto.randomBytes(16).toString("hex");
      const creditMsg = {
        process: AO_PROCESS_ID,
        data: JSON.stringify({
          processId: account.processId,
          amount: Math.floor(derivedBalance * 1e18)
        }),
        tags: [
          { name: "Action", value: "CreditBalance" },
          { name: "Nonce", value: creditNonce }
        ],
        signer
      };
      try {
        const creditTx = await message(creditMsg);
        const creditResult = await result({ message: creditTx, process: AO_PROCESS_ID, timeout: 10000 });
        if (creditResult.Messages && creditResult.Messages.length > 0) {
          const creditData = JSON.parse(creditResult.Messages[0].Data);
          if (creditData.Success) {
            // Update internal balance (L) to now include the swept funds.
            internalBalance = Number(creditData.NewBalance) / 1e18;
            account.lastKnownBalance = internalBalance;
            saveUserAccounts();
            console.log(`[${new Date().toISOString()}] ✅ Internal balance updated to ${internalBalance} SEND after sweep.`);
          } else {
            return "❌ Failed to update internal balance after sweep.";
          }
        }
      } catch (err) {
        console.error(`[${new Date().toISOString()}] 🚨 Credit balance error: ${err.message}`);
        return "❌ Failed to update internal balance after sweep.";
      }
    }
    
    // Now, proceed with the withdrawal (on-chain transfer via SEND_TOKEN process)
    const withdrawNonce = crypto.randomBytes(16).toString("hex");
    const transferMsg = {
      process: SEND_TOKEN_PROCESS_ID,
      tags: [
        { name: "Action", value: "Transfer" },
        { name: "Recipient", value: walletAddress },
        { name: "Quantity", value: String(Math.floor(amount * 1e18)) },
        { name: "Nonce", value: withdrawNonce }
      ],
      signer // funds come from the primary wallet (masterKey)
    };
    
    try {
      const withdrawTx = await message(transferMsg);
      await result({ message: withdrawTx, process: SEND_TOKEN_PROCESS_ID, timeout: 1000 });
      
      // Now update the ledger by debiting the withdrawn amount.
      const debitSuccess = await debitInternalBalance(userId, amount);
      if (!debitSuccess) {
        return `✅ Withdrawal requested. TX: [View](https://www.ao.link/#/message/${withdrawTx})\n⚠️ Internal balance update failed.`;
      }
      return `✅ Withdrawal requested. TX: [View](https://www.ao.link/#/message/${withdrawTx})`;
    } catch (err) {
      console.error(`[${new Date().toISOString()}] 🚨 Withdraw error: ${err.message}`);
      return "❌ Withdrawal failed.";
    }
  }  

// Sweep derived wallet 
async function sweepDerivedWallet(userId, depositAddress, amount) {
    const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);
    log(`📤 Sweeping ${amount} SEND from derived wallet ${depositAddress} to primary wallet`);
  
    // Load derived keypair for the user from the derived_jwks folder
    const keypairFile = path.join(DERIVED_JWKS_DIR, `${userId}.json`);
    if (!fs.existsSync(keypairFile)) {
      throw new Error(`Derived keypair not found for user ${userId}`);
    }
    const derivedKeypair = JSON.parse(fs.readFileSync(keypairFile, "utf8"));
    const derivedSigner = createDataItemSigner(derivedKeypair);
  
    // Primary wallet address (using masterKey)
    const primaryWalletAddress = await arweave.wallets.jwkToAddress(masterKey);
  
    const transferMsg = {
      process: SEND_TOKEN_PROCESS_ID,
      tags: [
        { name: "Action", value: "Transfer" },
        { name: "Recipient", value: primaryWalletAddress },
        { name: "Quantity", value: String(Math.floor(amount * 1e18)) } // Raw units
      ],
      signer: derivedSigner // Use the derived wallet's signer here
    };
  
    try {
      const transferTx = await message(transferMsg);
      log(`📨 Sweep TX sent: ${transferTx}`);
      const transferResult = await result({ message: transferTx, process: SEND_TOKEN_PROCESS_ID, timeout: 10000 });
      log(`📥 Sweep result: ${JSON.stringify(transferResult)}`);
  
      let data;
      try {
        data = JSON.parse(transferResult.Messages[0].Data);
      } catch (err) {
        // If parsing fails, assume the response is a plain text success message.
        data = transferResult.Messages[0].Data;
        log(`Plain text response detected: ${data}`);
      }
  
      // If the response is a plain text message starting with "You transferred", we assume success.
      if (typeof data === "string" && data.startsWith("You transferred")) {
        log(`✅ Sweep completed successfully.`);
        return true;
      }
      // If the response is an object with a Success flag, check it.
      if (typeof data === "object" && data && data.Success) {
        log(`✅ Sweep completed, remaining balance: ${data.NewBalance / 1e18} SEND`);
        return true;
      }
      throw new Error("No valid sweep response");
    } catch (err) {
      log(`🚨 Sweep error: ${err.message}`);
      return false;
    }
  }  

// **Update Process Registration**
async function updateProcessRegistration(userId) {
    const account = userAccounts[userId];
    if (!account) return "❌ No account to update.";
    const updateNonce = crypto.randomBytes(16).toString("hex");
    const updateMsg = {
        process: AO_PROCESS_ID,
        data: JSON.stringify({
            processId: account.processId,
            depositAddress: account.depositAddress,
            parent: PARENT_PROCESS_ID
        }),
        tags: [
            { name: "Process-ID", value: account.processId },
            { name: "User-ID", value: userId },
            { name: "Deposit-Address", value: account.depositAddress },
            { name: "Parent", value: PARENT_PROCESS_ID },
            { name: "Nonce", value: updateNonce }
        ],
        signer
    };
    try {
        const updateTx = await message(updateMsg);
        const updateResult = await result({ message: updateTx, process: AO_PROCESS_ID, timeout: 5000 });
        if (updateResult?.Messages?.[0]?.Data) {
            const response = JSON.parse(updateResult.Messages[0].Data);
            if (response.Success) return `✅ Process registration updated. (TX: https://www.ao.link/#/message/${updateTx})`;
            return `❌ Update failed: ${response.message}`;
        }
        return "❌ Update sent, but no confirmation received.";
    } catch (err) {
        console.error(`[${new Date().toISOString()}] 🚨 Update error: ${err.message}`);
        return `❌ Error: ${err.message}`;
    }
}

// **Discord Bot Setup**
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

client.once("ready", () => {
    console.log(`[${new Date().toISOString()}] ✅ Bot ready as ${client.user.tag}`);
    client.user.setActivity("SEND IT!");
});

client.on("messageCreate", async (msg) => {
    if (!msg.content.startsWith("!") || msg.author.bot) return;

    const validSenditChannel = "1330757366072737825";
    const botSpamChannel = "695183265908129852";

    const args = msg.content.slice(1).trim().split(/\s+/);
    const command = args.shift().toLowerCase();
    const userId = msg.author.id;

    if (msg.channel.id === validSenditChannel && command !== "sendit") {
        msg.reply(`Only \`!sendit\` is allowed in this channel. For other commands, please use <#${botSpamChannel}>.`);
        return;
    }
    if (command === "sendit" && msg.channel.id !== validSenditChannel) {
        msg.reply(`\`!sendit\` commands are only allowed in <#${validSenditChannel}>. For other commands, please use <#${botSpamChannel}>.`);
        return;
    }

    console.log(`[${new Date().toISOString()}] 📥 Command: ${command} from ${userId}`);

    try {
        const account = await ensureUserProcess(userId);
        if (!account) {
            msg.reply("❌ Failed to initialize your AO process. Try again!");
            return;
        }

        switch (command) {
            case "deposit":
                console.log(`[${new Date().toISOString()}] 💰 Returning deposit address for ${userId}: ${account.depositAddress}`);
                (async () => {
                    try {
                        await checkBalance(userId);
                    } catch (err) {
                        console.error(`[${new Date().toISOString()}] ⚠️ Background balance check failed: ${err.message}`);
                    }
                })();
                msg.reply(`Your deposit address is: **${account.depositAddress}**\nYou may deposit SEND now.`);
                break;

            case "balance":
                const balanceResponse = await checkBalance(userId);
                msg.reply(balanceResponse.message);
                break;

            case "withdraw":
                const amount = parseFloat(args[0]);
                const walletAddress = args[1];
                if (!amount || !walletAddress) {
                    msg.reply("Usage: `!withdraw <amount> <walletAddress>`");
                    return;
                }
                msg.reply(await handleWithdraw(userId, amount, walletAddress));
                break;

            case "confirm":
                const withdrawalId = args[0];
                if (!withdrawalId) {
                    msg.reply("Usage: `!confirm <withdrawalId>`");
                    return;
                }
                msg.reply(await confirmWithdrawal(userId, withdrawalId));
                break;

            case "tip":
                const receiverMention = args[0];
                const tipAmount = parseFloat(args[1]);
                if (!receiverMention || !tipAmount) {
                    msg.reply("Usage: `!tip @user <amount>`");
                    return;
                }
                const receiverId = receiverMention.replace(/[<@!>]/g, "");
                msg.reply(await handleInternalTransfer(userId, receiverId, tipAmount));
                break;

            case "myprocess":
                msg.reply(`Your AO Process: [View](https://www.ao.link/#/entity/${account.processId})`);
                break;

            case "sendit": {
                const now = Math.floor(Date.now() / 1000);
                const userAcc = await ensureUserProcess(userId);
                if (!userAcc) {
                    msg.reply("⚠️ Failed to initialize your AO process. Try again!");
                    break;
                }

                // Calculate OG senders count
                const ogSenders = Object.values(userAccounts).filter(acc => acc.ogSender).length;

                // Award OG Sender role (first 20 users)
                if (!userAcc.ogSender && ogSenders < 20) {
                    userAcc.ogSender = `OG Sender #${ogSenders + 1}`;
                    saveUserAccounts();
                    console.log(`[${new Date().toISOString()}] 🏅 Assigned ${userAcc.ogSender} to user ${userId}`);
                    try {
                        const roleName = "OG SENDer";
                        let role = msg.guild.roles.cache.find(r => r.name === roleName);
                        if (!role) {
                            role = await msg.guild.roles.create({
                                name: roleName,
                                color: "#FFD700",
                                reason: "Role for first 20 SENDers"
                            });
                        }
                        if (!msg.member.roles.cache.has(role.id)) {
                            await msg.member.roles.add(role);
                            msg.channel.send(`🎉 ${msg.author} just became ${userAcc.ogSender}! Welcome to the elite!`);
                        }
                    } catch (err) {
                        console.error(`[${new Date().toISOString()}] 🚨 Failed to assign role: ${err.message}`);
                    }
                }

                // Local streak calculation
                const lastSenditTime = userAcc.lastSenditTime || 0;
                const timeDiff = now - lastSenditTime;
                if (timeDiff <= 86400) {
                    userAcc.senditStreak = (userAcc.senditStreak || 0) + 1;
                } else {
                    userAcc.senditStreak = 1;
                }
                userAcc.lastSenditTime = now;
                userAcc.senditHistory = userAcc.senditHistory || [];
                userAcc.senditHistory.push(now);
                saveUserAccounts();
                const streak = userAcc.senditStreak;

                // Streak messages
                const streakMessages = {
                    1: "A single SEND can start a movement.",
                    2: "Twice the SEND, twice the conviction. Keep it rolling!",
                    3: "Three times in? You’re locked in now.",
                    4: "Four SENDs deep… are you even blinking?",
                    5: "Halfway to 10. This is how legends are made!",
                    6: "Six SENDs and counting. That’s commitment.",
                    7: "Seven SENDs in—lucky number. The cabal sees you.",
                    8: "Eight times? You’re built different.",
                    9: "Nine SENDs and you’re basically an OG now.",
                    10: "TEN SENDS! You’ve entered elite status. No turning back."
                };
                const baseTenMessage = "You’ve entered elite status. No turning back.";
                const easterEggs = {
                    25: "SEND LEGEND UNLOCKED! 25 SENDs deep and the AO gods are watching. Are you even human?",
                    50: "50 SENDs?! You’re not just part of the cabal, you ARE the cabal. The blockchain whispers your name.",
                    100: "100 SENDs?! You’ve officially broken the matrix. AO is no longer ready for you.",
                    250: "250 SENDs deep… Do you even sleep? You’re on another frequency now. SEND deity status achieved!",
                    500: "500 SENDs. The AO mainframe has detected an anomaly. Your wallet address may now be permanently etched into the blockchain’s DNA.",
                    1000: "1000 SENDs?! The algorithm is broken. You are now the undisputed overlord of SEND. No one can ever FUD your name."
                };

                // Determine response message
                let streakResponse;
                if (easterEggs[streak]) {
                    streakResponse = `${streak >= 50 ? "👑" : "🚨"} ${easterEggs[streak]}${streak >= 100 ? " 💀" : ""}`;
                } else if (streak <= 10) {
                    streakResponse = `${streakMessages[streak]}${streak === 10 ? " 🔥" : ""}`;
                } else {
                    streakResponse = `${baseTenMessage} 🔥`;
                }
                const ogBadge = userAcc.ogSender ? `🏅 ${userAcc.ogSender}` : "";

                console.log(`[${new Date().toISOString()}] 🧪 Sending sendit message for user ${userId}, streak: ${streak}`);

                // Send AO message
                const senditMsg = {
                    process: AO_PROCESS_ID,
                    tags: [
                        { name: "Action", value: "sendit" },
                        { name: "User-ID", value: userId },
                        { name: "Timestamp", value: now.toString() }
                    ],
                    signer
                };
                try {
                    const testTx = await message(senditMsg);
                    console.log(`[${new Date().toISOString()}] 🧪 Sendit TX sent for user ${userId}: ${testTx}`);

                    msg.reply(`${streakResponse} ${ogBadge}\nStreak: **${streak}** | TX: [View](https://www.ao.link/#/message/${testTx})`);

                    // Background sync with AO
                    (async () => {
                        try {
                            const res = await result({ message: testTx, process: AO_PROCESS_ID, timeout: 3000 });
                            if (res.Messages && res.Messages.length > 0 && res.Messages[0].Data) {
                                const response = JSON.parse(res.Messages[0].Data);
                                if (response.Success && response.streak !== streak) {
                                    console.warn(`[${new Date().toISOString()}] ⚠️ Streak mismatch: local=${streak}, AO=${response.streak}`);
                                    userAcc.senditStreak = response.streak;
                                    userAcc.lastSenditTime = now;
                                    saveUserAccounts();
                                    msg.reply(`Streak synced! New streak: **${response.streak}**`);
                                }
                            }
                        } catch (err) {
                            console.error(`[${new Date().toISOString()}] 🚨 Sendit sync error: ${err.message}`);
                        }
                    })();
                } catch (err) {
                    console.error(`[${new Date().toISOString()}] 🚨 Error sending sendit message: ${err.message}`);
                    msg.reply(`⚠️ Failed to SEND it! ${ogBadge}\nStreak: **${streak}**\nError: ${err.message}`);
                }
                break;
            }

            case "mystats": {
                const statsMsg = {
                    process: AO_PROCESS_ID,
                    tags: [
                        { name: "Action", value: "Get-Sendit-Streak" },
                        { name: "User-ID", value: userId }
                    ],
                    signer
                };
                try {
                    const statsTx = await message(statsMsg);
                    const statsResult = await result({ message: statsTx, process: AO_PROCESS_ID, timeout: 5000 });
                    if (statsResult.Messages?.[0]?.Data) {
                        const data = JSON.parse(statsResult.Messages[0].Data);
                        if (data.Success) {
                            const streak = data.streak;
                            const lastTimestamp = data.lastTimestamp;
                            const lastSenditDate = lastTimestamp ? new Date(lastTimestamp * 1000).toLocaleString() : "Never";
                            msg.reply(`📊 **Your SEND't Stats (AO State)**:\n- Current Streak: **${streak}**\n- Last SEND't: **${lastSenditDate}**\n\nNote: Full history not yet available on AO. Showing current state only.`);
                        } else {
                            msg.reply(`❌ Failed to retrieve stats: ${data.message}`);
                        }
                    } else {
                        msg.reply("❌ No response from AO.");
                    }
                } catch (err) {
                    console.error(`[${new Date().toISOString()}] 🚨 Stats error: ${err.message}`);
                    msg.reply("❌ Error retrieving stats from AO.");
                }
                break;
            }

            case "update":
                msg.reply(await updateProcessRegistration(userId));
                break;

            case "sweep":
                msg.reply(await handleWithdrawalSweep());
                break;

            case "debugaccount":
                msg.reply(`📌 **Account Info**:\n- Discord ID: ${userId}\n- Process ID: ${account.processId}\n- Deposit Address: ${account.depositAddress}`);
                break;

            case "tips":
                msg.reply(
                    "```\n" +
                    "Available Commands:\n" +
                    "- !deposit: Get your deposit address\n" +
                    "- !balance: Check your balance\n" +
                    "- !withdraw <amount> <walletAddress>: Withdraw SEND\n" +
                    "- !confirm <withdrawalId>: Confirm a withdrawal\n" +
                    "- !tip @user <amount>: Tip another user\n" +
                    "- !myprocess: View your AO process\n" +
                    "- !sendit: Test AO and track streaks\n" +
                    "- !mystats: View your SEND't stats\n" +
                    "- !update: Update process registration\n" +
                    "- !sweep: Trigger withdrawal sweep\n" +
                    "- !debugaccount: Debug your account\n" +
                    "- !tips: Show this help\n" +
                    "```"
                );
                break;

            default:
                return;
        }
    } catch (err) {
        console.error(`[${new Date().toISOString()}] 🚨 Command error: ${err.message}`);
        msg.reply("❌ An error occurred. Try again later.");
    }
});

client.login(DISCORD_TOKEN).catch(err => {
    console.error(`[${new Date().toISOString()}] 🚨 Login error: ${err.message}`);
    process.exit(1);
});