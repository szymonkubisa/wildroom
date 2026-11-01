<script setup lang="ts">
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { answerConfirm, confirmOpen, confirmShown } from './useConfirm'
</script>

<template>
  <!-- The one dialog behind useConfirm(): Cancel (focused first) or Esc answers no, the confirm button yes. -->
  <AlertDialog :open="confirmOpen" @update:open="(v) => !v && answerConfirm(false)">
    <AlertDialogContent data-confirm-dialog="">
      <AlertDialogHeader>
        <AlertDialogTitle>{{ confirmShown?.title }}</AlertDialogTitle>
        <AlertDialogDescription v-if="confirmShown?.description" class="whitespace-pre-line">{{ confirmShown.description }}</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>{{ confirmShown?.cancelText ?? 'Cancel' }}</AlertDialogCancel>
        <Button :variant="confirmShown?.destructive ? 'destructive' : 'default'" data-confirm-ok="" @click="answerConfirm(true)">
          {{ confirmShown?.confirmText ?? 'OK' }}
        </Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
