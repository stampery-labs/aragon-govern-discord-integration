import { Message } from 'discord.js'
import { inject, injectable } from 'inversify'
import { createDataRequest } from './createDataRequest'
import { parseProposalMessage } from './parseProposalMessage'
import { parseSetupMessage } from './parseSetupMessage'
import { CommandFinder } from './commandFinder'
import { TYPES } from '../types'
import { sendRequestToWitnetNode } from '../nodeMethods/sendRequestToWitnetNode'
import { waitForTally } from '../nodeMethods/waitForTally'
import { SubgraphClient } from './subgraph'
import { RegistryEntry } from './subgraph/types'

// Maps guild IDs to DAOs
interface DaoDirectory {
  [guildId: string]: RegistryEntry
}
import { reportVotingResult } from './reportVotingResult'
import { executeVotingResult } from './executeVotingResult'

@injectable()
export class MessageHandler {
  private commandFinder: CommandFinder
  private daoDirectory: DaoDirectory
  private subgraphClient: SubgraphClient

  constructor (@inject(TYPES.CommandFinder) commandFinder: CommandFinder) {
    this.commandFinder = commandFinder
    this.daoDirectory = {}
    this.subgraphClient = new SubgraphClient()
  }

  handle (message: Message): Promise<Message | Array<Message>> | undefined {
    if (!message.author.bot) {
      if (this.commandFinder.isNewProposalMessage(message.content)) {
        return this.newProposal(message)
      } else if (this.commandFinder.isSetupMessage(message.content)) {
        return this.setup(message)
      } else if (this.commandFinder.isNewDaoMessage(message.content)) {
        return MessageHandler.newDao(message)
      } else {
        return
      }
    } else {
      return
    }
  }

  private static newDao (message: Message): Promise<Message> {
    const id = message.id
    const log = `DAO with ID ${id} is being created`
    // TODO: make a call to create a DAO
    return message.reply(log)
  }

  private newProposal (message: Message): Promise<Message> {
    // define proposal message structure and parse new proposal message
    const {
      channelId,
      guildId,
      messageId,
      proposalDeadline,
      proposalMessage
    } = parseProposalMessage(message)
    const deadline = Date.parse(proposalDeadline)
    const currentTime = Date.now()

    const id = message.id
    const log = `Received a request for creating a proposal with message_id='${id}' and deadline=${new Date(
      deadline
    )}`
    console.log('[BOT]:' + log)

    // Prevent this method from being called privately
    if (!guildId) {
      return message.reply(
        `Sorry, this method can't be used in direct messaging. Please use it in a channel.`
      )
    }

    const dao = this.daoDirectory[guildId]
    if (!dao) {
      return message.reply(
        `Sorry, this DAO isn't connected yet to any DAO. Please connect it to a DAO using the \`!setup\` command like this:` +
          `\n\`!setup theNameOfYourDao\``
      )
    }

    if (!proposalMessage) {
      return message.reply(
        `The proposal should follow this format:\n'\`!proposal [MM dd yyyy HH:mm:ss] [message]'\``
      )
    }

    if (deadline <= currentTime) {
      return message.reply(
        `The entered deadline for the voting period is already past. Please try again with a future date and time.`
      )
    } else {
      // call createDataRequest with channelId and messageId
      setTimeout(() => {
        console.log(
          `Creating Witnet data request for channelId ${channelId} and messageId ${messageId}`
        )
        const request = createDataRequest(channelId, messageId)
        console.log('Created Witnet data request:', request)

        sendRequestToWitnetNode(
          request,
          (drTxHash: string) => {
            console.log(`Data request sent to Witnet node, drTxHash: ${drTxHash}`)
            waitForTally(
              drTxHash,
              async (tally: any) => {
                console.log('Tallied proposal result:', tally.tally)
                const report = await reportVotingResult(dao, drTxHash, `${Math.round(Date.now() / 1000 + 60)}`)
                if (report) {
                  message.reply(`The ID of the data request (${drTxHash}) has been reported to the Ethereum contract (${report?.transactionHash})`)
                } else {
                  message.reply(`There was an error reporting the proposal result`)
                }
                setTimeout(async () => {
                  const transactionHash = await executeVotingResult(dao, report?.payload)
                  if (transactionHash) {
                    message.reply(`The proposal has been executed in Ethereum transaction: ${transactionHash}`)
                  } else {
                    message.reply(`There was an error executing the proposal`)
                  }
                }, 60000)
              },
              () => {}
            )
          },
          () => {}
        )
        // TODO: it can overflow if the proposal is scheduled far in the future.
      }, deadline - currentTime)
      return message.reply(log)
    }
  }

  private async setup (message: Message): Promise<Message> {
    const { daoName, guildId, requester } = parseSetupMessage(message)
    console.log(
      `Received setup request for Discord guild ${guildId} trying to integrate with DAO named "${daoName}"`
    )

    // Make sure a DAO name has been provided
    if (!daoName) {
      return message.reply(
        `The setup command should follow this format:\n\`!setup theNameOfYourDao\``
      )
    }

    // Reject requests from non-admin users
    if (!requester?.hasPermission('ADMINISTRATOR')) {
      return message.reply(
        `Sorry, only users with Admin permission are allowed to setup this integration.`
      )
    }

    // Prevent this method from being called privately
    if (!guildId) {
      return message.reply(
        `Sorry, this method can't be used in direct messaging. Please use it in a channel.`
      )
    }

    // Make sure that the DAO name exists in the Aragon Govern subgraph
    const dao = await this.subgraphClient.queryDaoByName(daoName)
    if (!dao) {
      return message.reply(
        `Sorry, couldn't find a registered DAO named "${daoName}"`
      )
    }

    // Keep track of the Discord server <> DAO name relation
    this.daoDirectory[guildId] = dao

    return message.reply(
      `Congrats to you and your fellow Discord users! This server is now connected to the DAO named "${daoName}".` +
        `\n\n**Remember to also add these other bots to your server**, otherwise the integration will fail:` +
        `\n- Witnet Foundation Reactions Monitor: https://discord.com/api/oauth2/authorize?client_id=806098500978343986&permissions=65536&scope=bot%20messages.read` +
        `\n- Aragon One Reactions Monitor: https://discord.com/api/oauth2/authorize?client_id=806819543460610068&permissions=65536&scope=bot%20messages.read` +
        `\n- OtherPlane Reactions Monitor: https://discord.com/api/oauth2/authorize?client_id=806821381844762625&permissions=65536&scope=bot%20messages.read`
    )
  }
}
