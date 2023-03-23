import { Blockchain, SandboxContract, TreasuryContract, Verbosity, internal } from '@ton-community/sandbox';
import { Cell, toNano, beginCell, storeMessageRelaxed, Address, SendMode, OpenedContract, AccountStorage } from 'ton-core';
import { JettonWallet } from '../../wrappers/JettonWallet';
import { JettonMinter } from '../../wrappers/JettonMinter';
import { Voting } from '../../wrappers/Voting';
import { VoteKeeper } from '../../wrappers/VoteKeeper';
import '@ton-community/test-utils';
import { compile } from '@ton-community/blueprint';
import { differentAddress, getRandom, getRandomExp, getRandomInt, getRandomPayload, getRandomTon, randomAddress, renewExp } from "../utils";

type voteCtx = {
    init: boolean,
    votedFor: bigint,
    votedAgainst: bigint
};

type ActiveWallet       = SandboxContract<TreasuryContract>;
type ActiveJettonWallet = SandboxContract<JettonWallet>;

type sortBalanceResult  = {
    min: ActiveJettonWallet,
    max: ActiveJettonWallet,
    maxBalance: bigint,
    minBalance: bigint,
    isEq: boolean,
    hasZero: boolean
};

type walletDesc = {
    user:   ActiveWallet,
    jetton: ActiveJettonWallet,
    balance:bigint
}

type pickWinnerResult = {
    winner: walletDesc,
    loser:  walletDesc
};


describe('Votings', () => {
    jest.setTimeout(15000);
    let jwallet_code = new Cell();
    let minter_code = new Cell();
    let voting_code = new Cell();
    let vote_keeper_code = new Cell();
    let minter_update = new Cell();
    let blockchain: Blockchain;
    let user1:ActiveWallet;
    let user2:ActiveWallet;
    let user3:ActiveWallet;
    let initialUser1Balance:bigint;
    let initialUser2Balance:bigint;
    let initialUser3Balance:bigint;
    let votes:voteCtx[] = []; // Array index is voting index
    let genMessage:(to:Address, value:bigint, body:Cell) => Cell;
    let sortBalance:(w1:ActiveJettonWallet, w2:ActiveJettonWallet) => Promise<sortBalanceResult>;
    let pickWinner:(u1:ActiveWallet, u2:ActiveWallet) => Promise<pickWinnerResult>;
    let DAO:SandboxContract<JettonMinter>;
    let userWallet:(address:Address) => Promise<ActiveJettonWallet>;
    let votingContract:(voting_id:bigint) => Promise<SandboxContract<Voting>>;
    let voteKeeperContract:(wallet:ActiveJettonWallet, keeper_addr:Address) => Promise<SandboxContract<VoteKeeper>>;
    let defaultContent:Cell;
    let expirationDate:bigint;
    let assertKeeper:(vAddr:Address, wallet:ActiveJettonWallet, votes:bigint) => void;
    let votingId:bigint;

    beforeAll(async () => {
        jwallet_code = await compile('JettonWallet');
        minter_code = await compile('JettonMinter');
        voting_code = await compile('Voting');
        vote_keeper_code = await compile('VoteKeeper');
        minter_update    = await compile('MinterUpdate');
        blockchain = await Blockchain.create();
        user1 = await blockchain.treasury('user1');
        user2 = await blockchain.treasury('user2');
        user3 = await blockchain.treasury('user3');
        initialUser1Balance = getRandomTon(100, 1000);
        initialUser2Balance = getRandomTon(100, 1000);
        initialUser3Balance = getRandomTon(100, 1000);
        defaultContent = beginCell().endCell();
        votingId = 0n;
        DAO = blockchain.openContract(
                   await JettonMinter.createFromConfig(
                     {
                       admin: user1.address,
                       content: defaultContent,
                       wallet_code: jwallet_code,
                       voting_code: voting_code,
                       vote_keeper_code: vote_keeper_code
                     },
                     minter_code));
        userWallet = async (address:Address) => blockchain.openContract(
                          JettonWallet.createFromAddress(
                            await DAO.getWalletAddress(address)
                          )
                     );
        votingContract = async (voting_id:bigint) => blockchain.openContract(
                          Voting.createFromAddress(
                            await DAO.getVotingAddress(voting_id)
                          )
                     );
        voteKeeperContract = async (jw:ActiveJettonWallet, voting_addr:Address) => blockchain.openContract(
            VoteKeeper.createFromAddress(
                await jw.getVoteKeeperAddress(voting_addr)
            )
        );

        sortBalance = async (w1:ActiveJettonWallet, w2:ActiveJettonWallet) => {
            const balance1 = await w1.getJettonBalance();
            const balance2 = await w2.getJettonBalance();
            let sortRes:sortBalanceResult;

            if(balance1 >= balance2) {
                sortRes = {
                    min: w2,
                    max: w1,
                    maxBalance: balance1,
                    minBalance: balance2,
                    isEq: balance1 == balance2,
                    hasZero: balance2 == 0n
                };
            }
            else {
                sortRes = {
                    min: w1,
                    max: w2,
                    maxBalance: balance2,
                    minBalance: balance1,
                    isEq: false,
                    hasZero: balance1 == 0n
                };
            }

            return sortRes;
        };

        genMessage = (to:Address, value:bigint, body:Cell) => {
            return beginCell().store(storeMessageRelaxed(
                {
                    info: {
                        type: "internal",
                        bounce: true,
                        bounced: false,
                        ihrDisabled: true,
                        dest: to,
                        value: {coins: value},
                        ihrFee: 0n,
                        forwardFee: 0n,
                        createdLt: 0n,
                        createdAt:0
                    },
                    body

                }
            )).endCell();

        };

        pickWinner = async (u1: ActiveWallet, u2: ActiveWallet) => {
            const w1 = await userWallet(u1.address);
            const w2 = await userWallet(u2.address);
            let comp = await sortBalance(w1, w2);

            let res: pickWinnerResult;
            let winner: ActiveWallet;
            let loser: ActiveWallet;


           if(comp.max == w1) {
                winner = u1;
                loser  = u2;
           }
           else {
                winner = u2;
                loser  = u1;
           }


            const mintAmount = comp.isEq || comp.hasZero
                             ? getRandomTon(1, 10)
                             : 0n;
            /*
             * Now, since we have to carry state across all tests
             * we need to make sure that
             * 1) Balance of those jetton wallets differ
             * 2) None of those is 0
             * Otherwise can't vote successfully
             */
            // Meh

            if(comp.isEq) {
                // Topup the largest so balance is not equal
                await DAO.sendMint(user1.getSender(),
                                   winner.address,
                                   mintAmount,
                                   toNano('0.05'),
                                   toNano('1'));
                comp.maxBalance += mintAmount;
            }
            if(comp.hasZero) {
                // Topup lowest in case it's zero
                await DAO.sendMint(user1.getSender(),
                                   loser.address,
                                   mintAmount - 1n, // Make sure both have different balances
                                   toNano('0.05'),
                                   toNano('1'));

                comp.minBalance += mintAmount - 1n;
           }

           return {
               winner: {
                   user: winner,
                   jetton: comp.max,
                   balance: comp.maxBalance
               },
               loser: {
                   user: loser,
                   jetton: comp.min,
                   balance: comp.minBalance
               }
           };

        };

        assertKeeper = async (vAddr: Address, wallet:ActiveJettonWallet, expVotes:bigint) => {
            const keepR      = await voteKeeperContract(wallet, vAddr);
            const keeperData = await keepR.getData();

            expect(keeperData.voter_wallet.equals(wallet.address)).toBeTruthy();
            expect(keeperData.voting.equals(vAddr)).toBeTruthy();
            expect(keeperData.votes).toEqual(expVotes);


   }

        await DAO.sendDeploy(user1.getSender(), toNano('1'));
        await DAO.sendMint(user1.getSender(), user1.address, initialUser1Balance, toNano('0.05'), toNano('1'));
        await DAO.sendMint(user1.getSender(), user2.address, initialUser2Balance, toNano('0.05'), toNano('1'));
        await DAO.sendMint(user1.getSender(), user3.address, initialUser3Balance, toNano('0.05'), toNano('1'));
    });
    it('should create new voting', async () => {
            expirationDate = getRandomExp();
            let voting = await votingContract(votingId);

            const randTon    = getRandomTon(1, 2000);
            const payload    = getRandomPayload();
            const minExec    = toNano('0.1');

            let createVoting = await DAO.sendCreateVoting(user1.getSender(),
                expirationDate,
                minExec, // minimal_execution_amount
                randomAddress(),
                toNano('0.1'), // amount
                payload // payload
            );

            // Voting deploy message
            expect(createVoting.transactions).toHaveTransaction({
                from: DAO.address,
                to: voting.address,
                deploy: true
            });

            // Voting initiated message to DAO
            expect(createVoting.transactions).toHaveTransaction({
                from: voting.address,
                to: DAO.address,
                body: JettonMinter.createVotingInitiated(votingId, expirationDate, user1.address)
            });

            // Confirmation message
            expect(createVoting.transactions).toHaveTransaction({ //notification
                        from: DAO.address,
                        to: user1.address,
                        body: beginCell().storeUint(0xc39f0be6, 32) //// voting created
                                         .storeUint(0, 64) //query_id
                                         .storeAddress(voting.address) //voting_code
                                         .endCell()
                    });

            const votingData = await voting.getData();

            votes[0] = votingData;

            const proposal = JettonMinter.createProposalBody(minExec, payload);

            expect(votingData.votingId).toEqual(votingId);
            expect(votingData.daoAddress.equals(DAO.address)).toBeTruthy();
            expect(votingData.proposal.equals(proposal)).toBeTruthy();
            expect(votingData.executed).toBe(false);
            expect(votingData.expirationDate).toEqual(expirationDate);
            expect(votingData.initiator.equals(user1.address)).toBeTruthy();
            expect(votingData.init).toEqual(true);
            expect(votingData.votedFor).toEqual(0n);
            expect(votingData.votedAgainst).toEqual(0n);
    });

    it('Should not allow voting initiated message from non-voting', async () =>{
        const voting   = await votingContract(votingId);

        let   res = await DAO.sendVotingInitiated(user1.getSender(),
                                                  votingId,
                                                  expirationDate,
                                                  user1.address);
        expect(res.transactions).toHaveTransaction({
            from: user1.address,
            to: DAO.address,
            success: false,
            exitCode: 78
        });

        const voteSender = blockchain.sender(voting.address);

        res = await DAO.sendVotingInitiated(voteSender,
                                            votingId + 1n, // Incorrect voting id
                                            expirationDate,
                                            user1.address);
                                            //
        // Voting with different id would get different address
        expect(res.transactions).toHaveTransaction({
            from: voting.address,
            to: DAO.address,
            success: false,
            exitCode: 78
        });

        res = await DAO.sendVotingInitiated(voteSender,
                                            votingId, // Correct id
                                            expirationDate,
                                            user1.address);
        expect(res.transactions).toHaveTransaction({
            from: voting.address,
            to: DAO.address,
            success: true
        });

        expect(res.transactions).toHaveTransaction({
            from: DAO.address,
            to: user1.address,
            body: beginCell().storeUint(0xc39f0be6, 32) //// voting created
                             .storeUint(0, 64) //query_id
                             .storeAddress(voting.address) //voting_code
                             .endCell()

        });

    });

    it('jetton owner can vote for', async () => {
            let voting     = await votingContract(votingId);

            let votingCode = await DAO.getVotingCode();
            const user1JettonWallet = await userWallet(user1.address);
            const voteCtx  = votes[0];
            let voteResult = await user1JettonWallet.sendVote(user1.getSender(), voting.address, expirationDate, true, false);
            expect(voteResult.transactions).toHaveTransaction({ //notification
                        from: voting.address,
                        to: user1.address,
                        // excesses 0xd53276db, query_id
                        body: beginCell().storeUint(0xd53276db, 32).storeUint(0, 64).endCell()
                    });


            voteCtx.votedFor += initialUser1Balance;

            await assertKeeper(voting.address, user1JettonWallet, voteCtx.votedFor);

            const votingData = await voting.getData();

            expect(votingData.init).toEqual(voteCtx.init);
            expect(votingData.votedFor).toEqual(initialUser1Balance);
            expect(votingData.votedAgainst).toEqual(voteCtx.votedAgainst);
            expect(await user1JettonWallet.getJettonBalance()).toEqual(voteCtx.votedAgainst);


        });

        it('jetton owner can vote against', async () => {

            let voting     = await votingContract(votingId);
            let votingData = await voting.getData();
            let voteCtx    = votes[0];

            expect(votingData.init).toEqual(voteCtx.init);
            expect(votingData.votedFor).toEqual(voteCtx.votedFor);
            expect(votingData.votedAgainst).toEqual(voteCtx.votedAgainst);

            const user3JettonWallet = await userWallet(user3.address);
            const voteRes           = await user3JettonWallet.sendVote(user3.getSender(), voting.address, expirationDate, false, false);


            expect(voteRes.transactions).toHaveTransaction({ //notification
                        from: voting.address,
                        to: user3.address,
                        // excesses 0xd53276db, query_id
                        body: beginCell().storeUint(0xd53276db, 32).storeUint(0, 64).endCell()
                    });


            voteCtx.votedAgainst += initialUser3Balance;

            await assertKeeper(voting.address, user3JettonWallet, voteCtx.votedAgainst);

            votingData     = await voting.getData();
            expect(votingData.init).toEqual(voteCtx.init);
            expect(votingData.votedFor).toEqual(voteCtx.votedFor);
            expect(votingData.votedAgainst).toEqual(voteCtx.votedAgainst);

        });

        it('jetton owner can not transfer just after voting', async () => {
            const user1JettonWallet = await userWallet(user1.address);
            let transferResult = await user1JettonWallet.sendTransfer(user1.getSender(), toNano('0.1'), //tons
                   1n, user1.address,
                   user1.address, null, toNano('0.05'), null);
            expect(transferResult.transactions).toHaveTransaction({ //failed transfer
                        from: user1.address,
                        to: user1JettonWallet.address,
                        exitCode: 706 //error::not_enough_jettons = 706;
                    });
        });

        it('jetton owner can transfer tokens which did not vote', async () => {
            const user2JettonWallet = await userWallet(user2.address);
            const transferVal = getRandomTon(2, 10);
            await user2JettonWallet.sendTransfer(user2.getSender(), toNano('0.15'), //tons
                   transferVal, user1.address,
                   user1.address, null, toNano('0.05'), null);
            const user1JettonWallet = await userWallet(user1.address);
            expect(await user1JettonWallet.getJettonBalance()).toEqual(transferVal);
            let transferResult = await user1JettonWallet.sendTransfer(user1.getSender(), toNano('0.15'), //tons
                   1n, user2.address,
                   user1.address, null, toNano('0.05'), null);
            expect(transferResult.transactions).not.toHaveTransaction({ //failed transfer
                        from: user1.address,
                        to: user1JettonWallet.address,
                        exitCode: 706 //error::not_enough_jettons = 706;
                    });
            expect(transferResult.transactions).toHaveTransaction({ // excesses
                        from: user2JettonWallet.address,
                        to: user1.address,
                        // excesses 0xd53276db, query_id
                        body: beginCell().storeUint(0xd53276db, 32).storeUint(0, 64).endCell()
                    });
            expect(await user1JettonWallet.getJettonBalance()).toEqual(transferVal - 1n);
        });

        it('jetton owner can vote second time but only with new jettons', async () => {
            let voting     = await votingContract(votingId);
            const voteCtx  = votes[0];
            let votingCode = await DAO.getVotingCode();
            const user1JettonWallet = await userWallet(user1.address);
            const walletData = await user1JettonWallet.getDaoData();
            let voteResult = await user1JettonWallet.sendVote(user1.getSender(), voting.address, expirationDate, false, false);
            expect(voteResult.transactions).toHaveTransaction({ //notification
                        from: voting.address,
                        to: user1.address,
                        // excesses 0xd53276db, query_id
                        body: beginCell().storeUint(0xd53276db, 32).storeUint(0, 64).endCell()
                    });

            voteCtx.votedAgainst += walletData.balance;

            await assertKeeper(voting.address, user1JettonWallet, walletData.balance + walletData.locked);

            const votingData = await voting.getData();

            expect(votingData.init).toEqual(voteCtx.init);
            expect(votingData.votedFor).toEqual(voteCtx.votedFor);
            expect(votingData.votedAgainst).toEqual(voteCtx.votedAgainst);
            expect(await user1JettonWallet.getJettonBalance()).toEqual(0n);
        });

    it('jetton owner can vote in the other voting', async () => {
            let voting     = await votingContract(++votingId);
            expirationDate = renewExp(expirationDate);

            const createVoting = await DAO.sendCreateVoting(user1.getSender(),
                expirationDate,
                toNano('0.1'), // minimal_execution_amount
                randomAddress(),
                toNano('0.1'), // amount
                beginCell().endCell() // payload
            );

            expect(createVoting.transactions).toHaveTransaction({
                from: DAO.address,
                to: user1.address,
                body: beginCell().storeUint(0xc39f0be6, 32) //// voting created
                                         .storeUint(0, 64) //query_id
                                         .storeAddress(voting.address) //voting_code
                                         .endCell()

            });
            let votingData = await voting.getData();

            expect(votingData.init).toEqual(true);
            expect(votingData.votedFor).toEqual(0n);
            expect(votingData.votedAgainst).toEqual(0n);

            const voteCtx  = votingData as voteCtx;
            votes[1]       = voteCtx;


            const user1JettonWallet = await userWallet(user1.address);
            const walletBalance     = await user1JettonWallet.getLockedBalance();
            let voteResult = await user1JettonWallet.sendVote(user1.getSender(), voting.address, expirationDate, true, false);

            expect(voteResult.transactions).toHaveTransaction({ //notification
                        from: voting.address,
                        to: user1.address,
                        // excesses 0xd53276db, query_id
                        body: beginCell().storeUint(0xd53276db, 32).storeUint(0, 64).endCell()
                    });

            voteCtx.votedFor += walletBalance;

            await assertKeeper(voting.address, user1JettonWallet, voteCtx.votedFor);

            votingData = await voting.getData();

            expect(votingData.init).toEqual(voteCtx.init);
            expect(votingData.votedFor).toEqual(voteCtx.votedFor);
            expect(votingData.votedAgainst).toEqual(voteCtx.votedAgainst);
            expect(await user1JettonWallet.getJettonBalance()).toEqual(0n);
        });


    it('Should not be able to request vote confirmation from non-voting address', async() => {
        const voting = await votingContract(votingId);
        const jetton = await userWallet(user1.address);

        let res = await DAO.sendConfirmVoting(user1.getSender(), votingId, jetton.address)
        expect(res.transactions).toHaveTransaction({
            from: user1.address,
            to: DAO.address,
            success: false,
            exitCode: 78
        });
        expect(res.transactions).not.toHaveTransaction({
            from: DAO.address,
            to: jetton.address
        });

    });

    it('Vote confirmation should voting address should depend on voting id', async() => {

        const voting = await votingContract(votingId);
        const jetton = await userWallet(user1.address);

        let res = await DAO.sendConfirmVoting(blockchain.sender(jetton.address), votingId + 1n, user1.address)
        expect(res.transactions).toHaveTransaction({
            from: jetton.address,
            to: DAO.address,
            success: false,
            exitCode: 78
        });
        expect(res.transactions).not.toHaveTransaction({
            from: DAO.address,
            to: user1.address
        });


    });

    it('jetton owner can vote with confirmation', async () => {
            expirationDate = renewExp(expirationDate);
            await DAO.sendCreateVoting(user1.getSender(),
                expirationDate,
                toNano('0.1'), // minimal_execution_amount
                randomAddress(),
                toNano('0.1'), // amount
                beginCell().endCell() // payload
            );
            let voting = await votingContract(++votingId);
            const voteCtx  = (await voting.getData()) as voteCtx;
            votes[Number(votingId)] = voteCtx;

            let votingCode = await DAO.getVotingCode();
            const user1JettonWallet = await userWallet(user1.address);
            const walletBalance     = await user1JettonWallet.getTotalBalance();

            let voteResult = await user1JettonWallet.sendVote(user1.getSender(), voting.address, expirationDate, false, true);
            expect(voteResult.transactions).toHaveTransaction({ //vote_confirmation
                        from: user1JettonWallet.address,
                        to: user1.address,
                        body: beginCell().storeUint(0x5fe9b8ca, 32).storeUint(0, 64).endCell()
                    });

            voteCtx.votedAgainst += walletBalance;


            await assertKeeper(voting.address, user1JettonWallet, voteCtx.votedAgainst);

            let votingData = await voting.getData();

            expect(votingData.init).toEqual(voteCtx.init);
            expect(votingData.votedFor).toEqual(voteCtx.votedFor);
            expect(votingData.votedAgainst).toEqual(voteCtx.votedAgainst);

            expect(await user1JettonWallet.getJettonBalance()).toEqual(0n);
        });

        it('jetton balance unblocked after expiration date', async () => {
            const user1JettonWallet = await userWallet(user1.address);
            let   daoData           = await user1JettonWallet.getDaoData();

            expect(daoData.locked).toBeGreaterThan(0n);

            const totalBalance      = daoData.balance + daoData.locked;

            blockchain.now = Number(expirationDate + 1n);

            // await new Promise(res => setTimeout(res, Number((expirationDate + 1n) * 1000n) - Date.now()));
            // expect(await user1JettonWallet.getJettonBalance()).toEqual(totalBalance);

            daoData = await user1JettonWallet.getDaoData();
            expect(daoData.locked).toEqual(0n);
            expect(daoData.lockExpiration).toBe(0);

            // const wdata = await blockchain.runGetMethod(user1JettonWallet.address, 'get_wallet_data', [], /*{now: Number(expirationDate) + 1 }*/);
            // expect(wdata.stackReader.readBigNumber()).toEqual(totalBalance);
            // check that voting data didn't changed
            let voting     = await votingContract(0n);
            let votingData = await voting.getData();
            const voteCtx  = votes[0];
            expect(votingData.init).toEqual(voteCtx.init);
            expect(votingData.votedFor).toEqual(voteCtx.votedFor);
            expect(votingData.votedAgainst).toEqual(voteCtx.votedAgainst);
        });

        it('Vote won', async () => {

            let winner:ActiveWallet;
            let loser:ActiveWallet;

            expirationDate = getRandomExp(blockchain.now);

            const payload  = getRandomPayload();
            const winMsg   = genMessage(user1.address, toNano('0.05'), payload);

            let voting = await votingContract(++votingId);

            const votingRes = await DAO.sendCreateVoting(user1.getSender(),
                expirationDate,
                toNano('0.1'), // minimal_execution_amount
                randomAddress(),
                toNano('0.5'), // amount
                winMsg // payload
            );

            expect(votingRes.transactions).toHaveTransaction({ //notification
                        from: DAO.address,
                        to: user1.address,
                        body: beginCell().storeUint(0xc39f0be6, 32) //// voting created
                                         .storeUint(0, 64) //query_id
                                         .storeAddress(voting.address) //voting_code
                                         .endCell()
            });

            const comp = await pickWinner(user1, user2);

            await comp.winner.jetton.sendVote(comp.winner.user.getSender(),
                                              voting.address,
                                              expirationDate, true, false);

            await comp.loser.jetton.sendVote(comp.loser.user.getSender(),
                                             voting.address,
                                             expirationDate, false, false);

            blockchain.now = Number(expirationDate) + 1;
            // await new Promise(res => setTimeout(res, Number(td * 1000n)));

            let voteData = await voting.getData();
            expect(voteData.executed).toBe(false);

            const res = await voting.sendEndVoting(user1.getSender());

            expect(res.transactions).toHaveTransaction({
                from: voting.address,
                to: DAO.address,
                body: JettonMinter.createExecuteVotingMessage(votingId,
                                                              expirationDate,
                                                              voteData.votedFor,
                                                              voteData.votedAgainst,
                                                              winMsg)
            });

            voteData = await voting.getData();
            expect(voteData.executed).toBe(true);

            // Expect winMsg to be sent from DAO
            expect(res.transactions).toHaveTransaction({
                from: DAO.address,
                to: user1.address,
                body: payload
            });

            votes[Number(votingId)] = voteData;
        })

        it('Vote lost', async () => {

            let winner:ActiveWallet;
            let loser:ActiveWallet;

            expirationDate   = getRandomExp(blockchain.now);

            const payload  = getRandomPayload();
            const winMsg   = genMessage(user1.address, toNano('0.05'), payload);

            let voting = await votingContract(++votingId);

            const votingRes = await DAO.sendCreateVoting(user1.getSender(),
                expirationDate,
                toNano('0.1'), // minimal_execution_amount
                randomAddress(),
                toNano('0.5'), // amount
                winMsg// payload
            );

            expect(votingRes.transactions).toHaveTransaction({ //notification
                        from: DAO.address,
                        to: user1.address,
                        body: beginCell().storeUint(0xc39f0be6, 32) //// voting created
                                         .storeUint(0, 64) //query_id
                                         .storeAddress(voting.address) //voting_code
                                         .endCell()
            });

            const comp = await pickWinner(user1, user2);

            // Now winner votes against
            await comp.winner.jetton.sendVote(comp.winner.user.getSender(),
                                              voting.address,
                                              expirationDate, false, false);

            await comp.loser.jetton.sendVote(comp.loser.user.getSender(),
                                             voting.address,
                                             expirationDate, true, false);

            blockchain.now = Number(expirationDate) + 1;
            // await new Promise(res => setTimeout(res, Number(td * 1000n)));

            let voteData = await voting.getData();
            expect(voteData.executed).toBe(false);

            const res = await voting.sendEndVoting(user1.getSender());

            expect(res.transactions).toHaveTransaction({
                from: voting.address,
                to: DAO.address,
                success: true,
                body: JettonMinter.createExecuteVotingMessage(votingId,
                                                              expirationDate,
                                                              voteData.votedFor,
                                                              voteData.votedAgainst,
                                                              winMsg
                                                             )
            });

            voteData = await voting.getData();

            expect(voteData.executed).toBe(true);

            // No proposal message from DAO
            expect(res.transactions).not.toHaveTransaction({
                from: DAO.address,
                to: user1.address,
                body: payload,
                success: true
            });

            votes[Number(votingId)] = voteData;
        })

        it('Execute vote result should only allow voting address', async() => {

            expirationDate = getRandomExp(blockchain.now);

            const payload  = getRandomPayload();
            const winMsg   = genMessage(user1.address, toNano('0.05'), payload);

            const supply   = await DAO.getTotalSupply();

            const voting       = await votingContract(votingId);
            const votingSender = blockchain.sender(voting.address);

            blockchain.now = Number(expirationDate) + 1;

            let res = await DAO.sendExecuteVotingMessage(user1.getSender(),
                                                         votingId,
                                                         expirationDate,
                                                         supply,
                                                         0n,
                                                         winMsg);

            const proposalTrans = {
                from: DAO.address,
                to: user1.address,
                body: payload
            };

            expect(res.transactions).toHaveTransaction({
                from: user1.address,
                to: DAO.address,
                success: false,
                exitCode: 78
            });

            expect(res.transactions).not.toHaveTransaction(proposalTrans);

            res = await DAO.sendExecuteVotingMessage(votingSender,
                                                     votingId,
                                                     expirationDate,
                                                     supply,
                                                     0n,
                                                     winMsg);
            // console.log(res.transactions[1].description);
            expect(res.transactions).toHaveTransaction({
                from: voting.address,
                to: DAO.address,
                success: true
            });

            expect(res.transactions).toHaveTransaction(proposalTrans);
        });

        it('Vote should not execute before expiery', async () => {

            expirationDate = getRandomExp(blockchain.now);

            const payload  = getRandomPayload();
            const winMsg   = genMessage(user1.address, toNano('0.05'), payload);
            const supply   = await DAO.getTotalSupply();
            const voting   = await votingContract(votingId);
            const votingSender = blockchain.sender(voting.address);

            let res = await DAO.sendExecuteVotingMessage(votingSender,
                                                         votingId,
                                                         expirationDate,
                                                         supply,
                                                         0n,
                                                         winMsg);

            const proposalTrans = {
                from: DAO.address,
                to: user1.address,
                body: payload
            };

            expect(res.transactions).toHaveTransaction({
                from: voting.address,
                to: DAO.address,
                success: false,
                exitCode: 0xf6
            });

            expect(res.transactions).not.toHaveTransaction(proposalTrans);

            blockchain.now = Number(expirationDate) + 1;

            res = await DAO.sendExecuteVotingMessage(votingSender,
                                                     votingId,
                                                     expirationDate,
                                                     supply,
                                                     0n,
                                                     winMsg);
            expect(res.transactions).toHaveTransaction({
                from: voting.address,
                to: DAO.address,
                success: true
            });

            expect(res.transactions).toHaveTransaction(proposalTrans);
        });

        it('DAO self-admin case', async () => {
            const prevAdmin = await DAO.getAdminAddress();
            await DAO.sendChangeAdmin(user1.getSender(), DAO.address);

            expirationDate = getRandomExp(blockchain.now);

            let curAdmin = await DAO.getAdminAddress();
            // DAO now admins itself
            expect(DAO.address.equals(curAdmin)).toBeTruthy();

            // Now we need to craft admin change message
            const adminChg  = JettonMinter.changeAdminMessage(user2.address);
            const chgMsg    = genMessage(DAO.address, 0n, adminChg);

            // Create voting
            await DAO.sendCreateVoting(user1.getSender(),
                                       expirationDate,
                                       toNano('0.1'), // minimal_execution_amount
                                       randomAddress(),
                                       toNano('0.5'), // amount
                                       chgMsg // payload
            );

            const voting = await votingContract(++votingId);
            const user2JettonWallet = await userWallet(user2.address);

            await user2JettonWallet.sendVote(user2.getSender(),
                                             voting.address,
                                             expirationDate,
                                             true, false);

            blockchain.now = Number(expirationDate) + 1;
            const res = await voting.sendEndVoting(user2.getSender());

            expect(res.transactions).toHaveTransaction({
                from: DAO.address,
                to: DAO.address,
                success: true,
                body: adminChg
            });

            curAdmin = await DAO.getAdminAddress();
            expect(curAdmin.equals(user2.address)).toBe(true);

            // We have to set admin all the way back to make sure other cases work fine
            await DAO.sendChangeAdmin(user2.getSender(), prevAdmin);
        });

        it('Code upgrade should only be allowed from admin', async() => {
            const curAdmin    = await DAO.getAdminAddress();
            const notAdmin    = differentAddress(curAdmin);

            let res = await DAO.sendCodeUpgrade(blockchain.sender(notAdmin), minter_update, null);
            expect(res.transactions).toHaveTransaction({
                from: notAdmin,
                to: DAO.address,
                success: false,
                exitCode: 79
            });

        });

        it('Code upgrade successfull', async () => {
            // Will slack compiling modified voting and use random cell
            const votingUpdate = getRandomPayload();
            const prevVoting   = await DAO.getVotingCode();
            expect(prevVoting.equals(votingUpdate)).toBe(false);

            const testMsg = internal({
                from: user1.address,
                to: DAO.address,
                value: toNano('0.1'),
                body: beginCell().storeUint(42, 32).storeUint(0, 64).endCell()
            });

            // Expect unknown op
            let res = await blockchain.sendMessage(testMsg);
            expect(res.transactions).toHaveTransaction({
                from: user1.address,
                to: DAO.address,
                success: false,
                exitCode: 0xffff // unknown op

            });

            res = await DAO.sendCodeUpgrade(user1.getSender(), minter_update, votingUpdate);
            expect(res.transactions).toHaveTransaction({
                from: user1.address,
                to: DAO.address,
                success: true
            });


            // Now it supposed to work
            res = await blockchain.sendMessage(testMsg);
            expect(res.transactions).toHaveTransaction({
                from: user1.address,
                to: DAO.address,
                success: true
            });

            // Voting code should update too
            expect((await DAO.getVotingCode()).equals(votingUpdate)).toBe(true);
            //
            // Have to switch code back since we drag blockchain state
            await DAO.sendCodeUpgrade(user1.getSender(), minter_code, prevVoting);
            expect(res.transactions).toHaveTransaction({
                from: user1.address,
                to: DAO.address,
                success: true
            });
        });
});
