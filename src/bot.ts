import { Telegraf, session, Context, Markup  } from "telegraf";
import { Connection, PublicKey } from "@solana/web3.js";
import { getMint, getAccount } from "@solana/spl-token";
import { db } from "./lib/db";
import * as dotenv from "dotenv";
import Web3 from "web3";
import { isAddress } from "ethers";


dotenv.config();

const bot = new Telegraf<MyContext>(process.env.BOT_TOKEN || "");
const API_KEY = process.env.API_KEY || "";
const UNISWAP_V4_POOL_MANAGER = process.env.UNISWAP_V4_POOL_MANAGER || "0x000000000004444c5dc75cB358380D2e3dE08A90";

bot.use(session());

const connection = new Connection("https://solana-mainnet.g.alchemy.com/v2/7MhrOFJdbrpHzDB8yhYw9mD0zjzGPeux");
const rpcURL = [{ 
                 'bsc': "https://bsc-dataseed.binance.org", 
                 'ethereum' : "https://eth-mainnet.g.alchemy.com/v2/7MhrOFJdbrpHzDB8yhYw9mD0zjzGPeux"
                }];
type AnyObject = Record<string, any>;
type PoolsByDex = Record<string, string[]>;
// Temporary in-memory map (userId -> payload)
const callbackStore: Record<string, { token: string; wallets: string[] }> = {};

import { ethers } from "ethers";

const CHAINS = {
  ethereum: {
    rpc: "https://eth.llamarpc.com",
    factory: "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f", // Uniswap V2
    wrapped: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH
  },
  bsc: {
    rpc: "https://bsc-dataseed.binance.org/",
    factory: "0xCA143Ce32Fe78f1f7019d7d551a6402fC5350c73", // Pancake V2
    wrapped: "0xBB4CdB9CBd36B01bD1b3EbF2De08d9173bc095c", // WBNB
  },
  polygon: {
    rpc: "https://polygon-rpc.com",
    factory: "0x5757371414417b8c6caad45baef941abc7d3ab32", // QuickSwap
    wrapped: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", // WMATIC
  },
};


const factoryAbi = [
  "function getPair(address tokenA, address tokenB) external view returns (address pair)"
];

const pairAbi = [
  "function token0() external view returns (address)",
  "function token1() external view returns (address)",
  "function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)"
];



const ERC20_ABI = [
   {
    constant: true,
    inputs: [],
    name: "totalSupply",
    outputs: [{ name: "", type: "uint256" }],
    type: "function",
  },
  {
    constant: true,
    inputs: [{ name: "_owner", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "balance", type: "uint256" }],
    type: "function",
  },
  {
    constant: true,
    inputs: [],
    name: "decimals",
    outputs: [{ name: "", type: "uint8" }],
    type: "function",
  },
  {
    constant: true,
    inputs: [],
    name: "symbol",
    outputs: [{ name: "", type: "string" }],
    type: "function",
  },
];


type MySession = {
  step?: string;
  tokenMint?: string;
  wallets?: string[];
};

// Extend Context to include session
interface MyContext extends Context {
  session?: MySession;
}


async function getNativePair(chain: keyof typeof CHAINS, token: string) {
  const { rpc, factory, wrapped } = CHAINS[chain];
  const provider = new ethers.JsonRpcProvider(rpc);

  const factoryContract = new ethers.Contract(factory, factoryAbi, provider);
  const pairAddr = await factoryContract.getPair(token, wrapped);

  if (pairAddr === ethers.ZeroAddress) {
    console.log(`No pair found for ${token} on ${chain}`);
    return null;
  }

  const pair = new ethers.Contract(pairAddr, pairAbi, provider);
  const [t0, t1] = await Promise.all([pair.token0(), pair.token1()]);
  const { reserve0, reserve1 } = await pair.getReserves();

  return {
    chain,
    pair: pairAddr
  };
}




// Save user config
async function saveUserConfig(userId: number, token: string, wallets: string[]) {
  const walletsJson = JSON.stringify(wallets);
  await db.query(
    `INSERT INTO user_config (user_id, token_address, wallets)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE token_address = VALUES(token_address), wallets = VALUES(wallets)`,
    [userId, token, walletsJson]
  );
}

// Load user config
async function getUserConfig(userId: number): Promise<{ token: string; wallets: string[] } | null> {
  const [rows] = await db.query(`SELECT * FROM user_config WHERE user_id = ?`, [userId]);
  const result = (rows as any[])[0];
  if (!result) return null;
  return { token: result.token_address, wallets: JSON.parse(result.wallets) };
}

bot.command("settoken", async (ctx) => {
  const parts = ctx.message.text.split(" ");
  if (parts.length < 2) return ctx.reply("Usage: /settoken <tokenAddress>");
  const token = parts[1];
  const userId = ctx.from?.id;
  if (!userId) return;
  
  const current = await getUserConfig(userId);
  const wallets = current?.wallets ?? [];

  await saveUserConfig(userId, token, wallets);
  ctx.reply(`✅ Token address saved: ${token}`);
});

bot.command("setwallets", async (ctx) => {
  const parts = ctx.message.text.split(" ");
  if (parts.length < 2) return ctx.reply("Usage: /setwallets <wallet1,wallet2,...>");
  const wallets = parts[1].split(",");
  const userId = ctx.from?.id;
  if (!userId) return;

  const current = await getUserConfig(userId);
  const token = current?.token ?? "";

  await saveUserConfig(userId, token, wallets);
  ctx.reply(`✅ Wallets saved: ${wallets.join(", ")}`);
});

bot.command("mystats", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const config = await getUserConfig(userId);
  if (!config) return ctx.reply("⚠️ You haven’t set your token and wallets yet.");

  // For now assume chain = Solana (you can extend with BSC/ETH later)
  const chain = "Solana";
  const token = config.token;
  const wallets = config.wallets;

   const tableText = `
📊 Your Config
<pre>
Token | ${token}
</pre>
  `;
 // Save in memory so button only needs userId
  callbackStore[userId] = { token, wallets };
  const keyboard = [
    [Markup.button.callback("📊 Check Token Stats", `check_token_${userId}`)]
  ];

  ctx.reply(tableText, {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard(keyboard)
  });

});

// Handle wallet buttons
bot.action(/check_wallet_(.+)/, async (ctx) => {
  const wallet = ctx.match[1];
  await ctx.answerCbQuery();
  ctx.reply(`✅ Wallet: <code>${wallet}</code>`, { parse_mode: "HTML" });
});


// Handle token stats button
bot.action(/check_token_(.+)/, async (ctx) => {
  const userId = ctx.match[1];
  const payload = callbackStore[userId];
  if (!payload) {
    return ctx.reply("⚠️ Session expired, please run /mystats again.");
  }

  const { token, wallets } = payload;

  await ctx.answerCbQuery();
  ctx.reply(
    `📊 Checking token stats:\n<b>Token:</b> ${token}`,
    { parse_mode: "HTML" }
  );

  // 👉 Call getTokenDistribution(token, wallets) here
  const result =  await getTokenDistribution(token, wallets);
   await ctx.reply(result, { parse_mode: "HTML" });
});


// Step 1: start command
bot.start(async (ctx) => {
  ctx.session = {}; // reset session
  await ctx.reply("👋 Welcome! Please send me the *token mint address*:", { parse_mode: "Markdown" });
  ctx.session.step = "awaiting_mint";
});

// Step 2: handle text inputs
bot.on("text", async (ctx) => {
  const userId = ctx.from?.id;
  let token = '';
  
  const current = await getUserConfig(userId);
  const wallets = current?.wallets ?? [];
  const msg = ctx.message.text.trim();


  if (ctx.session?.step === "awaiting_mint") {
    ctx.session.tokenMint = msg;
     token = ctx.session.tokenMint;
    ctx.session.step = "awaiting_wallets";
        await saveUserConfig(userId, token, wallets);
    return ctx.reply("✅ Got the token mint.\nNow send me the *owner wallets*, separated by commas:", { parse_mode: "Markdown" });
  }


  if (ctx.session?.step === "awaiting_wallets") {
    ctx.session.wallets = msg.split(",").map((w: string) => w.trim());
    const wallets = ctx.session.wallets;
    ctx.session.step = "done";
     const userId = ctx.from?.id;
     if (!userId) return;
    
    //store info
     const current = await getUserConfig(userId);
     const token = current?.token ?? "";
     await saveUserConfig(userId, token, wallets);

    // 👉 Call your stats function
    if (!ctx.session?.tokenMint || !ctx.session?.wallets) {
      return ctx.reply("❌ Session expired or invalid. Please type /start to try again.");
    }

    const result = await getTokenDistribution(ctx.session.tokenMint, ctx.session.wallets);
    await ctx.reply(result, { parse_mode: "HTML" });

    // 🔄 Reset for next run
    ctx.session = {};
    await ctx.reply("\n📌 Done! If you want to check another token, please send me a *new token mint address*:", { parse_mode: "Markdown" });
    ctx.session.step = "awaiting_mint";
    return;
  }

  return ctx.reply("❌ Please type /start to begin.", { parse_mode: "HTML"});
});


// Helper to sum token balances for a wallet
async function sumTokenAccounts(walletAddress: string, mintPubKey: PublicKey) {

  
  let total = BigInt(0);
  const ownerPubKey = new PublicKey(walletAddress);
  const tokenAccounts = await connection.getTokenAccountsByOwner(ownerPubKey, { mint: mintPubKey });
  

  if (tokenAccounts && tokenAccounts.value && tokenAccounts.value.length > 0) {
  
      for (const { pubkey } of tokenAccounts.value) {
        // Fetch token account details
        const tokenAccountInfo = await getAccount(connection, pubkey);
        
        total += tokenAccountInfo.amount;
      }

  } else {
        const tokenAccountInfo = await getAccount(connection, ownerPubKey);
        total += tokenAccountInfo.amount;
    // no token accounts found for this owner + mint
  }


  return total;
}

function toArray(val: unknown): AnyObject[] {
  if (!val) return [];
  if (Array.isArray(val)) return val as AnyObject[];
  if (typeof val === "object") {
    const obj = val as AnyObject;
    //if (Array.isArray(obj.items)) return obj.items;
    if (Array.isArray(obj.pools)) return obj.pools;
    //if (Array.isArray(obj.data)) return obj.data;

    // if it looks like a single pool
    if ("pool_address" in obj || "pubkey" in obj || "address" in obj || "id" in obj) {
      return [obj];
    }

    return Object.values(obj);
  }
  return [];
   }

  function detectChain(address: string): "solana" | "ethereum/bsc" | "unknown" {
  // Ethereum/BSC format
  if (/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return "ethereum/bsc";
  }

  // Solana format (Base58, length between 32–44)
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
    return "solana";
  }

  return "unknown";
 }

async function solanTokenInfo(chain: string, tokenMintAddress: string, ownerWallets: string[]) {

  try {
    const mintPubKey = new PublicKey(tokenMintAddress);
    const mintInfo = await getMint(connection, mintPubKey);
    const decimals = mintInfo.decimals;
    const totalSupply = mintInfo.supply;

    const url = `https://defi.shyft.to/v0/pools/get_by_token?network=mainnet-beta&token=${tokenMintAddress}`;
        const res = await fetch(url, {
          headers: { "x-api-key": API_KEY }
        });

        const data = await res.json();
        const dexes = data?.result?.dexes ?? {};
        const allPools: string[] = []; 
        const vaults: string[] = [];

       for (const dexName of Object.keys(dexes)) {
          const arr = toArray(dexes[dexName]);
            //console.log(arr)
          arr.forEach(pool => {

            
        if (pool.baseMint === tokenMintAddress && pool.baseVault) vaults.push(pool.baseVault);
        if (pool.quoteMint === tokenMintAddress && pool.quoteVault) vaults.push(pool.quoteVault);

        if (pool.base_mint === tokenMintAddress && pool.pool_bump) vaults.push(pool.pool_base_token_account);
        if (pool.quote_mint === tokenMintAddress && pool.pool_bump) vaults.push(pool.pool_quote_token_account);

        if (pool.tokenMintA === tokenMintAddress && pool.tokenVaultA) vaults.push(pool.tokenVaultA);
        if (pool.tokenMintB === tokenMintAddress && pool.tokenVaultB) vaults.push(pool.tokenVaultB);
        if (pool.tokenXMint === tokenMintAddress && pool.reserveX) vaults.push(pool.reserveX);
        if (pool.tokenYMint === tokenMintAddress && pool.reserveY) vaults.push(pool.reserveY);
        
          });
        }

// Sum DEX balances concurrently
    const dexBalances = await Promise.all(
    vaults.map(async (wallet) => {
      const bal = await sumTokenAccounts(wallet, mintPubKey);
      return bal; // bigint
    })
    );

    // Keep only vaults with > 0 balance
    const nonZeroVaults = vaults.filter((_, i) => dexBalances[i] > BigInt(0));

    // Now calculate total DEX balance only from non-zero vaults
    const dexBalance = dexBalances.reduce((a, b) => a + b, BigInt(0));


    // Sum owner balances
    let ownerBalance = BigInt(0);
    for (const wallet of ownerWallets) {
      ownerBalance += await sumTokenAccounts(wallet, mintPubKey);
    }


    const unknownBalance = totalSupply - dexBalance - ownerBalance;

    const convertToNumber = (amount: bigint) => Number(amount) / Math.pow(10, decimals);
    const totalSupplyNum = convertToNumber(totalSupply);

    const dexPercent = (convertToNumber(dexBalance) / totalSupplyNum) * 100;
    const ownerPercent = (convertToNumber(ownerBalance) / totalSupplyNum) * 100;
    const unknownPercent = (convertToNumber(unknownBalance) / totalSupplyNum) * 100;

    return `
<b>Token Distribution</b>

<pre>
Category         Value
-----------------------------
Blockchain       ${chain}
Total Supply     ${totalSupplyNum.toFixed(6)}
Dex              ${dexPercent.toFixed(2)}%
Owner Wallets    ${ownerPercent.toFixed(2)}%
Unknown Wallets  ${unknownPercent.toFixed(2)}%
</pre>`;
  } catch (err) {
    console.error(err);
    return "⚠️ Error fetching token data. Please check the mint address and wallets.";
  }
  
}

async function ERCTokenInfo(chain: string, tokenMintAddress: string, ownerWallets: string[]) {
  try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenMintAddress}`);
      const data = await res.json();
      let bscPairs: string | any[] = [];
      if (!data.pairs || data.pairs.length === 0) {
        //return "❌ No pools found for this token.";
      const pairs = await getNativePair("ethereum",tokenMintAddress);
            bscPairs = [{ chainId: pairs?.chain, pairAddress: pairs?.pair}];
          console.log(bscPairs);
      }

      if(data.pairs){
      // Only keep BSC pairs
       bscPairs = data.pairs.filter((p: any) => p.chainId === "bsc" || p.chainId === "ethereum");
      }

      if (bscPairs.length === 0) {
        return "❌ No active pools found for this token.";
      }
      
      //  if(bscPairs[0]['chainId'] === 'ethereum'){ console.log(rpcURL[0].ethereum) }
        
      //console.log(bscPairs)
      const web3 = new Web3(bscPairs[0]['chainId'] === 'ethereum' ? rpcURL[0].ethereum.toString() : rpcURL[0].bsc.toString()); // mainnet RPC
      const tokenContract = new web3.eth.Contract(ERC20_ABI as any, tokenMintAddress);

      const decimals = Number(await tokenContract.methods.decimals().call());
      const totalSupply = BigInt(await tokenContract.methods.totalSupply().call());

      const convertToNumber = (amount: bigint) => Number(amount) / Math.pow(10, decimals);
      const totalSupplyNum = convertToNumber(totalSupply);

    // Sum owner balances
    let ownerBalance = 0;
    for (const wallet of ownerWallets) {
      ownerBalance +=  convertToNumber(BigInt(await tokenContract.methods.balanceOf(wallet).call()));
      
    }

    let dexBalance = 0;
      for (const p of bscPairs) {
       if (isAddress(p.pairAddress)){ 
        dexBalance +=  convertToNumber(BigInt(await tokenContract.methods.balanceOf(p.pairAddress).call()));
       }else{
          if(p.chainId === 'ethereum')
          dexBalance +=  convertToNumber(BigInt(await tokenContract.methods.balanceOf(UNISWAP_V4_POOL_MANAGER).call()));
          //console.log(dexBalance)
       }
      }

    const unknownBalance = (totalSupplyNum - dexBalance - ownerBalance);

    const dexPercent = ((dexBalance) / totalSupplyNum) * 100;
    const ownerPercent = ((ownerBalance) / totalSupplyNum) * 100;
    const unknownPercent = ((unknownBalance) / totalSupplyNum) * 100;
      
    return `
    <b>Token Distribution</b>

    <pre>
    Category         Value
    -----------------------------
    Blockchain       ${bscPairs[0]['chainId']}
    Total Supply     ${totalSupplyNum.toFixed(2)}
    Dex              ${dexPercent.toFixed(2)}%
    Owner Wallets    ${ownerPercent.toFixed(2)}%
    Unknown Wallets  ${unknownPercent.toFixed(2)}%
    </pre>`;

  } catch (error) {
    console.log(error);
        return "⚠️ Error fetching token data. Please check the mint address and wallets.";
  }
}
async function getTokenDistribution(tokenMintAddress: string, ownerWallets: string[]): Promise<string> {
  const chain =  detectChain(tokenMintAddress);

  if(chain === 'solana'){
   return await solanTokenInfo(chain, tokenMintAddress, ownerWallets);
  }else if(chain === 'ethereum/bsc'){
   return await ERCTokenInfo(chain, tokenMintAddress, ownerWallets);
  }else{
    return 'unknown chain';
  }


  /*try {
    const mintPubKey = new PublicKey(tokenMintAddress);
    const mintInfo = await getMint(connection, mintPubKey);
    const decimals = mintInfo.decimals;
    const totalSupply = mintInfo.supply;

    const url = `https://defi.shyft.to/v0/pools/get_by_token?network=mainnet-beta&token=${tokenMintAddress}`;
        const res = await fetch(url, {
          headers: { "x-api-key": API_KEY }
        });

        const data = await res.json();
        const dexes = data?.result?.dexes ?? {};
        const allPools: string[] = []; 
        const vaults: string[] = [];

       for (const dexName of Object.keys(dexes)) {
          const arr = toArray(dexes[dexName]);
            //console.log(arr)
          arr.forEach(pool => {

            
        if (pool.baseMint === tokenMintAddress && pool.baseVault) vaults.push(pool.baseVault);
        if (pool.quoteMint === tokenMintAddress && pool.quoteVault) vaults.push(pool.quoteVault);

        if (pool.base_mint === tokenMintAddress && pool.pool_bump) vaults.push(pool.pool_base_token_account);
        if (pool.quote_mint === tokenMintAddress && pool.pool_bump) vaults.push(pool.pool_quote_token_account);

        if (pool.tokenMintA === tokenMintAddress && pool.tokenVaultA) vaults.push(pool.tokenVaultA);
        if (pool.tokenMintB === tokenMintAddress && pool.tokenVaultB) vaults.push(pool.tokenVaultB);
        if (pool.tokenXMint === tokenMintAddress && pool.reserveX) vaults.push(pool.reserveX);
        if (pool.tokenYMint === tokenMintAddress && pool.reserveY) vaults.push(pool.reserveY);
        
          });
        }

// Sum DEX balances concurrently
    const dexBalances = await Promise.all(
    vaults.map(async (wallet) => {
      const bal = await sumTokenAccounts(wallet, mintPubKey);
      return bal; // bigint
    })
    );

    // Keep only vaults with > 0 balance
    const nonZeroVaults = vaults.filter((_, i) => dexBalances[i] > BigInt(0));

    // Now calculate total DEX balance only from non-zero vaults
    const dexBalance = dexBalances.reduce((a, b) => a + b, BigInt(0));


    // Sum owner balances
    let ownerBalance = BigInt(0);
    for (const wallet of ownerWallets) {
      ownerBalance += await sumTokenAccounts(wallet, mintPubKey);
    }


    const unknownBalance = totalSupply - dexBalance - ownerBalance;

    const convertToNumber = (amount: bigint) => Number(amount) / Math.pow(10, decimals);
    const totalSupplyNum = convertToNumber(totalSupply);

    const dexPercent = (convertToNumber(dexBalance) / totalSupplyNum) * 100;
    const ownerPercent = (convertToNumber(ownerBalance) / totalSupplyNum) * 100;
    const unknownPercent = (convertToNumber(unknownBalance) / totalSupplyNum) * 100;

    return `
<b>Token Distribution</b>

<pre>
Category         Value
-----------------------------
Blockchain       ${chain}
Total Supply     ${totalSupplyNum.toFixed(6)}
Dex              ${dexPercent.toFixed(2)}%
Owner Wallets    ${ownerPercent.toFixed(2)}%
Unknown Wallets  ${unknownPercent.toFixed(2)}%
</pre>`;
  } catch (err) {
    console.error(err);
    return "⚠️ Error fetching token data. Please check the mint address and wallets.";
  }*/
}

bot.launch();
