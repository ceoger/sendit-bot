# SENDIT Discord TipBot

A decentralized tip bot for Discord, powered by **AO Compute** and **Arweave**, enabling seamless **SEND token transactions** between users.

## Features
- **AO-USER Process** – Users get ** AO process created for them with a wallet** for transactions.
- **On-Chain Transfers** – Handles **SEND token deposits, withdrawals, and internal transfers**.
- **Automated Streak Tracking** – Keeps a history of transactions and engagement.
- **Security** – Uses **nonce-based transactions** to prevent replay attacks.

---

## Installation & Setup
### 1. Prerequisites
- Node.js **18+**
- Arweave wallet file (JWK)
- Discord bot token
- AO Connect configuration

### 2. Clone the Repository
```bash
git clone https://github.com/ceoger/sendit-bot.git
cd sendit-bot
```

### 3. Install Dependencies
```bash
npm install
```

### 4. Configure Environment Variables
Create a `.env` file and add the following:
```env
DISCORD_TOKEN=your-bot-token
ARWEAVE_WALLET_PATH=wallet.json
AO_PROCESS_ID=czYYWP96oA9xJJ1FMGUx_If144G7_EUL6yVIer30dQw
SEND_TOKEN_PROCESS_ID=your-project-token-process-id
SCHEDULER=_GQ33BkPtZrqxA84vM8Zk-N2aO0toNNu_C-l-rawrBA
AUTHORITY=fcoN_xJeisVsPXA-trzVAuIiqO3ydLQxM-L4XbrQKzY
PARENT_PROCESS_ID=MTZzREseC1gxnJJMnTJjOmPfhHmIzQGhtFu3-FS0bqA
MU_URL=https://mu.ao-testnet.xyz
CU_URL=https://cu.ao-testnet.xyz
GATEWAY_URL=https://arweave.net
```

### 5. Run the Bot
```bash
node bot.js
```

---

## Commands & Usage
### General
| Command | Description |
|---------|------------|
| `!deposit` | Get your deposit address for receiving SEND tokens. |
| `!balance` | Check your current SEND token balance. |
| `!withdraw <amount> <walletAddress>` | Withdraw SEND tokens to an external wallet. |
| `!confirm <withdrawalId>` | Confirm a pending withdrawal request. |
| `!tip @user <amount>` | Tip another user with SEND tokens. |
| `!sendit` | Track and engage with tipping streaks. |
| `!mystats` | View your personal transaction history and streak. |
| `!tips` | Display available bot commands. |

---

## Security & AO Best Practices
- **Nonce-based transactions** prevent replay attacks.
- **Exponential backoff retries** ensure reliable AO queries.
- **Persistent storage** of user accounts using JSON files.

---

## Troubleshooting
| Issue | Solution |
|--------|----------|
| Bot is not responding | Check if the bot is online and verify the `DISCORD_TOKEN`. |
| AO process is not found | Run `!update` to resync your AO wallet. |
| Withdrawal is stuck | Ensure you confirmed the withdrawal using `!confirm`. |

---

## Contributing
- Fork the repository  
- Create a feature branch  
- Submit a pull request  

---

## License
This project is licensed under the **MIT License**.

