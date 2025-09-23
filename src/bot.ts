import { Telegraf, session, Context } from "telegraf";
import { Connection, PublicKey } from "@solana/web3.js";
import { getMint, getAccount } from "@solana/spl-token";
import * as dotenv from "dotenv";
import Web3 from "web3";
import { isAddress } from "ethers";


dotenv.config();

const bot = new Telegraf<MyContext>(process.env.BOT_TOKEN || "");
const API_KEY = process.env.API_KEY || "";

bot.use(session());

const connection = new Connection("https://solana-mainnet.g.alchemy.com/v2/7MhrOFJdbrpHzDB8yhYw9mD0zjzGPeux");
const rpcURL = [{ 
                 'bsc': "https://bsc-dataseed.binance.org", 
                 'ethereum' : "https://eth-mainnet.g.alchemy.com/v2/7MhrOFJdbrpHzDB8yhYw9mD0zjzGPeux"
                }];
type AnyObject = Record<string, any>;
type PoolsByDex = Record<string, string[]>;

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

// Step 1: start command
bot.start(async (ctx) => {
  ctx.session = {}; // reset session
  await ctx.reply("👋 Welcome! Please send me the *token mint address*:", { parse_mode: "Markdown" });
  ctx.session.step = "awaiting_mint";
});

// Step 2: handle text inputs
bot.on("text", async (ctx) => {
  const msg = ctx.message.text.trim();

  if (ctx.session?.step === "awaiting_mint") {
    ctx.session.tokenMint = msg;
    ctx.session.step = "awaiting_wallets";
    return ctx.reply("✅ Got the token mint.\nNow send me the *owner wallets*, separated by commas:", { parse_mode: "Markdown" });
  }

  if (ctx.session?.step === "awaiting_wallets") {
    ctx.session.wallets = msg.split(",").map((w: string) => w.trim());
    ctx.session.step = "done";

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

      if (!data.pairs || data.pairs.length === 0) {
        return "❌ No pools found for this token.";
      }

      // Only keep BSC pairs
      const bscPairs = data.pairs.filter((p: any) => p.chainId === "bsc" || p.chainId === "ethereum");

      if (bscPairs.length === 0) {
        return "❌ No active pools found for this token.";
      }
      
        if(bscPairs[0]['chainId'] === 'ethereum'){
              console.log(rpcURL[0].ethereum)
        }
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
       if (isAddress(p.pairAddress)) 
        dexBalance +=  convertToNumber(BigInt(await tokenContract.methods.balanceOf(p.pairAddress).call()));
      }
      console.log(dexBalance)

    const unknownBalance = (totalSupplyNum - dexBalance - ownerBalance);
    console.log(unknownBalance)

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
